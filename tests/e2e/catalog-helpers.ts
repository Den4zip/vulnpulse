import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export async function launchCatalog() {
  const directory = mkdtempSync(join(tmpdir(), 'vulnpulse-catalog-ui-'))
  const profile = join(directory, 'profile')
  const launcher = join(directory, 'launch.cjs')
  writeFileSync(launcher, `
    const {app,dialog,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(profile)});delete process.env.ELECTRON_RENDERER_URL;
    const state=globalThis.__catalogTest={path:${JSON.stringify(resolve('examples/osv-demo.json'))},unexpectedNetwork:0,dialogs:0,failList:false,failGet:false,failWrite:false,failDashboard:false,holdDashboard:false,dashboards:[],holdSlow:false,slow:[],holdWrite:false,writes:[],holdGet:false,gets:[],holdPicker:false,pickers:[],failStackList:false,failStackGet:false,failStackWrite:false,failStackAfterWrite:false,holdStackSlow:false,stackSlow:[],holdStackGet:false,stackGets:[],holdStackWrite:false,stackWrites:[]};
    Object.assign(state,{failNotesList:false,failNoteGet:false,failSlaGet:false,failWorkflowWrite:false,failWorkflowAfterWrite:false,holdNotesOwner:null,notesLists:[],holdNoteGet:false,noteGets:[],holdSlaOwner:null,slaGets:[],holdWorkflowWrite:false,workflowWrites:[]});
    for(const protocol of ['http','https']) require(protocol).request=()=>{state.unexpectedNetwork++;throw new Error('External HTTP disabled in catalog UI test')};
    dialog.showOpenDialog=async()=>{state.dialogs++;if(state.holdPicker) await new Promise(resolve=>state.pickers.push(resolve));return {canceled:false,filePaths:[state.path]}};
    dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
    const handle=ipcMain.handle.bind(ipcMain);
    ipcMain.handle=(channel,listener)=>handle(channel,async(event,...args)=>{
      const stackWrite=['vulnpulse:stack:create','vulnpulse:stack:update','vulnpulse:stack:remove'].includes(channel);
      const workflowWrite=['vulnpulse:notes:create','vulnpulse:notes:update','vulnpulse:notes:remove','vulnpulse:sla:set','vulnpulse:sla:remove'].includes(channel);
      const workflowFail=channel==='vulnpulse:notes:list'?state.failNotesList:channel==='vulnpulse:notes:get'?state.failNoteGet:channel==='vulnpulse:sla:get'?state.failSlaGet:workflowWrite?state.failWorkflowWrite:false;
      const fail=channel==='vulnpulse:stack:list'?state.failStackList:channel==='vulnpulse:stack:get'?state.failStackGet:stackWrite?state.failStackWrite:channel==='vulnpulse:dashboard:get'?state.failDashboard:channel==='vulnpulse:vulnerabilities:list'?state.failList:channel==='vulnpulse:vulnerabilities:get'?state.failGet:channel==='vulnpulse:vulnerabilities:set-status'?state.failWrite:false;
      if(fail||workflowFail) return {ok:false,error:{code:'INTERNAL_ERROR',message:'private-provider-error-must-not-appear'}};
      const result=await listener(event,...args);
      if(workflowWrite&&state.failWorkflowAfterWrite&&result.ok) return {ok:false,error:{code:'UNAVAILABLE',message:'private-provider-error-must-not-appear'}};
      if(workflowWrite&&state.holdWorkflowWrite) await new Promise(resolve=>state.workflowWrites.push(resolve));
      if(channel==='vulnpulse:notes:list'&&args[0]?.vulnerabilityId===state.holdNotesOwner) await new Promise(resolve=>state.notesLists.push(resolve));
      if(channel==='vulnpulse:notes:get'&&state.holdNoteGet) await new Promise(resolve=>state.noteGets.push(resolve));
      if(channel==='vulnpulse:sla:get'&&args[0]?.vulnerabilityId===state.holdSlaOwner) await new Promise(resolve=>state.slaGets.push(resolve));
      if(stackWrite&&state.failStackAfterWrite&&result.ok) return {ok:false,error:{code:'UNAVAILABLE',message:'private-provider-error-must-not-appear'}};
      if(channel==='vulnpulse:stack:list'&&args[0]?.search==='slow'&&state.holdStackSlow) await new Promise(resolve=>state.stackSlow.push(resolve));
      if(channel==='vulnpulse:stack:get'&&state.holdStackGet) await new Promise(resolve=>state.stackGets.push(resolve));
      if(stackWrite&&state.holdStackWrite) await new Promise(resolve=>state.stackWrites.push(resolve));
      if(channel==='vulnpulse:dashboard:get'&&state.holdDashboard) await new Promise(resolve=>state.dashboards.push(resolve));
      if(channel==='vulnpulse:vulnerabilities:get'&&state.holdGet) await new Promise(resolve=>state.gets.push(resolve));
      if(channel==='vulnpulse:vulnerabilities:list'&&args[0]?.search==='slow'&&state.holdSlow) await new Promise(resolve=>state.slow.push(resolve));
      if(channel==='vulnpulse:vulnerabilities:set-status'&&state.holdWrite) await new Promise(resolve=>state.writes.push(resolve));
      return result;
    });
    require(${JSON.stringify(resolve('out/main/index.js'))});
  `)
  try {
    const app = await electron.launch({ args: [launcher], cwd: resolve('.') })
    const page = await app.firstWindow()
    const dbPath = join(profile, 'vulnpulse.db')
    return { app, page, dbPath, directory, launcher,
      cleanup: () => { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}

/** Synthetic catalog, inserted only into this test's explicitly created profile. */
export function seedCatalog(path: string, count = 120) {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN')
    db.prepare("INSERT INTO feeds(name,source) VALUES ('nvd','local:ui-fixture') ON CONFLICT DO NOTHING").run()
    db.prepare("INSERT INTO feeds(name,source) VALUES ('cisa','local:ui-fixture') ON CONFLICT DO NOTHING").run()
    const nvd = db.prepare("SELECT id FROM feeds WHERE name='nvd'").get()!.id
    const cisa = db.prepare("SELECT id FROM feeds WHERE name='cisa'").get()!.id
    const insert = db.prepare('INSERT INTO vulnerabilities(ext_id,feed_id,title,description,severity,cvss_score,status,is_known_exploited,published_at,modified_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id')
    const source = db.prepare('INSERT INTO source_records(feed_id,source_id,raw_json) VALUES(?,?,?) RETURNING id')
    const link = db.prepare('INSERT INTO vulnerability_sources(vulnerability_id,source_record_id) VALUES(?,?)')
    const severities = ['Critical', 'High', 'Medium', 'Low', 'None', null]
    for (let i = 0; i < count; i++) {
      const extId = `CVE-2026-${10000 + i}`
      const title = i === 0 ? '<img src=x onerror="window.__xss=1"> Demo gateway'
        : i === 1 ? 'Long title '.repeat(350) : i === 2 ? 'Literal %_! in title' : i === 3 ? 'slow fixture' : i === 4 ? 'fast fixture' : `Уязвимость компонента ${i}`
      const description = i === 0 ? '<script>window.__xss=1</script> Неисполняемый текст источника.' : i === 1 ? 'Длинное описание '.repeat(5000) : `Описание уязвимости ${i}. Обновите компонент.`
      const id = insert.get(extId, nvd as number, title, description, severities[i % 6], i % 6 === 5 ? null : i % 6 === 4 ? 0 : 9.8 - i % 4,
        i % 7 === 1 ? 'Analyzing' : 'New', i % 4 === 0 ? 1 : 0, '2026-11-01T00:00:00.000Z', '2026-11-06T00:00:00.000Z')!.id
      const record = source.get(nvd as number, extId, '{"fixture":true}')!.id
      link.run(id as number, record as number)
      if (i === 0) link.run(id as number, source.get(cisa as number, extId, '{"fixture":true}')!.id as number)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error } finally { db.close() }
}
