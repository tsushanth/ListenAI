import type { OfferedFeatures } from '../../content/launchFlags.ts'

/** MCP tools that belong to a feature that can be switched off (see launchFlags.ts). */
const TOOLS_BY_FEATURE: Record<keyof OfferedFeatures, readonly string[]> = {
  voiceDesign: ['design_voice', 'get_voice_design'],
  customVoiceStudio: ['create_voice_clone', 'upload_voice_clone_dataset', 'commit_voice_clone_dataset', 'get_voice_clone_status', 'deploy_voice_clone', 'delete_voice_clone'],
}

export function hiddenMcpTools(offered: OfferedFeatures): Set<string> {
  return new Set((Object.keys(TOOLS_BY_FEATURE) as (keyof OfferedFeatures)[]).flatMap((f) => (offered[f] ? [] : TOOLS_BY_FEATURE[f])))
}
