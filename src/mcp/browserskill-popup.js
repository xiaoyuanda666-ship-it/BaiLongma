// Only inspect tabs returned for this session's Agent Window, never user tabs.
export function mayOpenBrowserSkillTab(name, args) {
  return name === 'browser_click' || (name === 'browser_press_key' && /(?:^|\+)Enter$/i.test(args.key || ''))
}

export async function followBrowserSkillPopup(session, before, context) {
  const after = await session.call(['tab', 'list', '--scope', 'agent'], context, { tab: false })
  const known = new Set(before.map(tab => tab.tab_id))
  const added = (after.tabs || []).filter(tab => tab.scope === 'agent' && !known.has(tab.tab_id))
  if (!added.length) return null
  if (added.length !== 1 || !added[0].active) {
    throw Object.assign(new Error('The action opened tabs without a unique active destination; inspect task-owned tabs before continuing.'), {
      code: 'BSK_TAB_AMBIGUOUS', details: { new_tabs: added },
    })
  }
  const transition = { from_tab_id: session.tabId, tab_id: added[0].tab_id, url: added[0].url || '' }
  session.tabId = added[0].tab_id
  return transition
}

export async function refreshBrowserSkillPopupUrl(session, transition, context) {
  const result = await session.call(['tab', 'list', '--scope', 'agent'], context, { tab: false })
  const page = result.tabs?.find(tab => tab.scope === 'agent' && tab.tab_id === transition.tab_id)
  if (page?.url) transition.url = page.url
}

export async function waitForBrowserSkillPopup(session, context) {
  await session.call(['wait-for-navigation', '--wait-until', 'domcontentloaded', '--timeout', '10s'], context, { timeout: 15_000 })
}
