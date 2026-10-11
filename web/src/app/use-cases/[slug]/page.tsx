import { PageRoute, pageMetadata, staticSegments } from '@/components/library/route'

export const dynamicParams = false
export function generateStaticParams() {
  return staticSegments('use-case')
}
export function generateMetadata({ params }: { params: { slug: string } }) {
  return pageMetadata('use-case', params)
}
export default function Page({ params }: { params: { slug: string } }) {
  return <PageRoute type="use-case" params={params} />
}
