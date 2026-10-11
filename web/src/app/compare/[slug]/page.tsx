import { PageRoute, pageMetadata, staticSegments } from '@/components/library/route'

export const dynamicParams = false
export function generateStaticParams() {
  return staticSegments('compare')
}
export function generateMetadata({ params }: { params: { slug: string } }) {
  return pageMetadata('compare', params)
}
export default function Page({ params }: { params: { slug: string } }) {
  return <PageRoute type="compare" params={params} />
}
