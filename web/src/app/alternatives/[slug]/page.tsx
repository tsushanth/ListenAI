import { PageRoute, pageMetadata, staticSegments } from '@/components/library/route'

export const dynamicParams = false
export function generateStaticParams() {
  return staticSegments('alternatives')
}
export function generateMetadata({ params }: { params: { slug: string } }) {
  return pageMetadata('alternatives', params)
}
export default function Page({ params }: { params: { slug: string } }) {
  return <PageRoute type="alternatives" params={params} />
}
