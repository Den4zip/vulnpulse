import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

// Adapted from the shadcn/ui Button pattern; native button semantics are retained.
const buttonVariants = cva('inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground hover:bg-primary/90',
      outline: 'border border-input bg-card hover:bg-muted',
      ghost: 'hover:bg-muted text-muted-foreground hover:text-foreground'
    },
    size: { default: 'h-9 px-3', sm: 'h-8 px-2.5', icon: 'size-9' }
  }, defaultVariants: { variant: 'default', size: 'default' }
})
export function Button({ className, variant, size, type = 'button', ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
