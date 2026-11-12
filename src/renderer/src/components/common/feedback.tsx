import { AlertCircle, LoaderCircle } from 'lucide-react'
import { Button } from '../ui/button'

export function LoadingState({ label = 'Загрузка уязвимостей…' }: { label?: string }) {
  return <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{label}</div>
}
export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 text-center">
    <AlertCircle className="size-6 text-destructive" aria-hidden="true" /><p>{message}</p>
    <Button variant="outline" onClick={retry}>Повторить</Button>
  </div>
}
