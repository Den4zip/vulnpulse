import type { ComponentProps } from 'react'
import { cn } from '@renderer/lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn('h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 text-[13px] placeholder:text-muted-foreground disabled:opacity-50', className)} {...props} />
}
