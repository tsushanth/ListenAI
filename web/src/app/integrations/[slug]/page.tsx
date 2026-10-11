import { PageRoute, pageMetadata, staticSegments } from '@/components/library/route'

export const dynamicParams = false
export function generateStaticParams() {
  return staticSegments('integration')
}
export function generateMetadata({ params }: { params: { slug: string } }) {
  return pageMetadata('integration', params)
}
export default function Page({ params }: { params: { slug: string } }) {
  return <PageRoute type="integration" params={params} />
}
