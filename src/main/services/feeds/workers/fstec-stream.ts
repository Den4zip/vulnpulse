import { FSTEC_MAX_RECORD, FSTEC_MAX_RECORDS } from '../fstec-data'

/** Streaming record framing only. fast-xml-parser validates and parses each record.
 * Understands quotes/comments/CDATA so embedded closing-tag text cannot split records.
 */
export class FstecXmlStream {
  private pending = ''
  private readonly stack: string[] = []
  private parts: string[] | null = null
  private size = 0
  private opened = false
  private closed = false
  private declaration = false
  private count = 0

  private append(text: string): void {
    if (!this.parts) return
    this.size += Buffer.byteLength(text)
    if (this.size > FSTEC_MAX_RECORD) throw new Error('FSTEC record exceeds 2 MiB')
    this.parts.push(text)
  }

  async push(text: string, emit: (record: string) => Promise<void>): Promise<void> {
    this.pending += text
    while (this.pending) {
      const start = this.pending.indexOf('<')
      if (start !== 0) {
        const end = start < 0 ? this.pending.length : start
        const value = this.pending.slice(0, end)
        if (this.stack.length < 2 && value.trim()) throw new Error('Text outside FSTEC records')
        this.append(value)
        this.pending = this.pending.slice(end)
        continue
      }
      let end = -1
      let special = ''
      if (this.pending.startsWith('<!--')) { end = this.pending.indexOf('-->', 4); if (end >= 0) end += 3; special = 'comment' }
      else if (this.pending.startsWith('<![CDATA[')) { end = this.pending.indexOf(']]>', 9); if (end >= 0) end += 3; special = 'cdata' }
      else if (this.pending.startsWith('<?')) { end = this.pending.indexOf('?>', 2); if (end >= 0) end += 2; special = 'pi' }
      else if (this.pending.startsWith('<!')) {
        if (['<!--', '<![CDATA['].some((prefix) => prefix.startsWith(this.pending))) break
        throw new Error('FSTEC DTD and declarations are forbidden')
      } else {
        let quote = ''
        for (let i = 1; i < this.pending.length; i++) {
          const ch = this.pending[i]
          if (quote) { if (ch === quote) quote = '' }
          else if (ch === '"' || ch === "'") quote = ch
          else if (ch === '>') { end = i + 1; break }
        }
      }
      if (end < 0) {
        if (Buffer.byteLength(this.pending) > FSTEC_MAX_RECORD) throw new Error('FSTEC XML token too large')
        break
      }
      const token = this.pending.slice(0, end)
      this.pending = this.pending.slice(end)
      if (special) {
        if (special === 'pi') {
          if (this.opened || this.declaration || !/^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])utf-8\2)?(?:\s+standalone=(["'])(?:yes|no)\3)?\s*\?>$/i.test(token)) {
            throw new Error('Unsupported FSTEC XML declaration')
          }
          this.declaration = true
        } else if (special === 'cdata' && this.stack.length < 2) throw new Error('CDATA outside FSTEC record')
        else if (special === 'comment' && token.slice(4, -3).includes('--')) throw new Error('Invalid FSTEC XML comment')
        this.append(token)
        continue
      }
      const close = /^<\/([a-zA-Z_][\w.:-]*)\s*>$/.exec(token)
      if (close) {
        if (this.stack.pop() !== close[1]) throw new Error('Mismatched FSTEC XML tags')
        this.append(token)
        if (this.stack.length === 1) {
          if (!this.parts) throw new Error('Unexpected FSTEC closing tag')
          const record = this.parts.join('')
          this.parts = null
          this.size = 0
          if (++this.count > FSTEC_MAX_RECORDS) throw new Error('Too many FSTEC records')
          await emit(record)
        } else if (!this.stack.length) this.closed = true
        continue
      }
      const open = /^<([a-zA-Z_][\w.:-]*)(?=[\s/>])/.exec(token)
      if (!open || this.closed) throw new Error('Unsupported FSTEC XML structure')
      if (!this.stack.length) {
        if (this.opened || !/^<vulnerabilities\s*>$/.test(token)) throw new Error('Expected vulnerabilities root')
        this.opened = true
      } else if (this.stack.length === 1) {
        if (!/^<vul\s*>$/.test(token)) throw new Error('Expected vul record')
        this.parts = []
      }
      this.append(token)
      if (!token.endsWith('/>')) {
        this.stack.push(open[1])
        if (this.stack.length > 32) throw new Error('FSTEC XML nesting exceeds 32')
      }
    }
  }

  finish(): void {
    if (this.pending || this.stack.length || !this.closed || !this.count) throw new Error('Incomplete or empty FSTEC XML')
  }
}
