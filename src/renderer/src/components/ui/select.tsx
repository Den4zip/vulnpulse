import type { ComponentProps } from 'react'
import { cn } from '@renderer/lib/utils'

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn('h-9 min-w-0 rounded-md border border-input bg-card px-2 text-[13px] disabled:opacity-50', className)} {...props} />
}
