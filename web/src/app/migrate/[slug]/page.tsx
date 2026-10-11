import { PageRoute, pageMetadata, staticSegments } from '@/components/library/route'

export const dynamicParams = false
export function generateStaticParams() {
  return staticSegments('migrate')
}
export function generateMetadata({ params }: { params: { slug: string } }) {
  return pageMetadata('migrate', params)
}
export default function Page({ params }: { params: { slug: string } }) {
  return <PageRoute type="migrate" params={params} />
}
