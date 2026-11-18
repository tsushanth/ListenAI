// Every Google Play link on this site goes through playUrl(), so each install can be traced to the placement that sent it.
// Convention (same on all our sites): referrer = utm_source=<app>_web & utm_medium=web & utm_campaign=<placement>, URL-encoded.
// Do not put these links behind a redirect or shortener: it can drop the referrer. Do not add &listing= (not documented to
// work together with &referrer=).
export const PLAY_PACKAGE = 'com.listenai'
export const PLAY_UTM_SOURCE = 'readaloud_web'

export type PlayPlacement = 'hero' | 'footer' | 'nav' | 'home_reader' | 'app_settings' | 'webpro_success' | 'llms'

export function playUrl(placement: PlayPlacement): string {
  const referrer = `utm_source=${PLAY_UTM_SOURCE}&utm_medium=web&utm_campaign=${placement}`
  return `https://play.google.com/store/apps/details?id=${PLAY_PACKAGE}&referrer=${encodeURIComponent(referrer)}`
}
