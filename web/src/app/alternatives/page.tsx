import { HubRoute, hubMetadata } from '@/components/library/route'

export const dynamic = 'force-static'
export function generateMetadata() {
  return hubMetadata('alternatives')
}
export default function Page() {
  return <HubRoute hub="alternatives" />
}
