import type { ComponentProps } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

// shadcn/ui composition with Radix modal/focus handling and a scrollable side panel.
export const Dialog = DialogPrimitive.Root
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description
export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[#292331]/35" />
    <DialogPrimitive.Content className={cn('fixed inset-y-0 right-0 z-50 flex w-[min(620px,100vw)] flex-col border-l border-border bg-card shadow-2xl outline-none', className)} {...props}>
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label="Закрыть">
        <X size={18} aria-hidden="true" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
}
