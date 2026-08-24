function countSelectedItemsByDomain(frame, collection) {
  const domainsBySourceId = new Map((collection.results || []).map(result => (
    [result.source.id, result.source.domain]
  )))
  const counts = {}
  for (const item of frame.contextItems || []) {
    const domain = domainsBySourceId.get(item.event?.source?.id) || 'general'
    counts[domain] = (counts[domain] || 0) + 1
  }
  return counts
}

export function buildInformationSourceCoverageAudit(baseAudit, frame, collection) {
  const fullySelectedSourceIds = fullySelectedInformationSourceIds(frame, collection)
  const coveredComponents = new Set((collection.results || [])
    .filter(result => fullySelectedSourceIds.has(result.source.id))
    .flatMap(result => result.source.legacyComponents || []))
  const legacyEntries = Object.entries(baseAudit.legacyCharsByComponent || {})
  const legacyCoverageByComponent = Object.fromEntries(legacyEntries.map(([name]) => (
    [name, coveredComponents.has(name) ? 1 : 0]
  )))
  const legacyCoveredChars = legacyEntries.reduce((sum, [name, chars]) => (
    sum + (coveredComponents.has(name) ? chars : 0)
  ), 0)
  const legacyContextChars = Number(baseAudit.legacyContextChars) || 0
  return {
    sourceItemsByDomain: collection.audit.sourceItemsByDomain || {},
    selectedSourceItemsByDomain: countSelectedItemsByDomain(frame, collection),
    legacyCoveredComponentCount: Object.values(legacyCoverageByComponent).filter(Boolean).length,
    legacyUncoveredComponentCount: Object.values(legacyCoverageByComponent).filter(value => !value).length,
    legacyCoveredChars,
    legacyUncoveredChars: Math.max(0, legacyContextChars - legacyCoveredChars),
    legacyCoveragePermille: legacyContextChars > 0
      ? Math.round((legacyCoveredChars * 1_000) / legacyContextChars)
      : 1_000,
    sourceToLegacyCharRatioPermille: legacyContextChars > 0
      ? Math.round((Number(frame.audit?.contextChars || 0) * 1_000) / legacyContextChars)
      : 0,
    legacyCoverageByComponent,
  }
}

export function fullySelectedInformationSourceIds(frame, collection) {
  const selectedItemCountsBySource = {}
  for (const item of frame.contextItems || []) {
    const sourceId = String(item.event?.source?.id || '').trim()
    if (sourceId) selectedItemCountsBySource[sourceId] = (selectedItemCountsBySource[sourceId] || 0) + 1
  }
  return new Set((collection.results || [])
    .filter(result => (
      result.ok
      && result.items.length > 0
      && (Number(result.truncatedItemCount) || 0) === 0
      && selectedItemCountsBySource[result.source.id] === result.items.length
    ))
    .map(result => result.source.id))
}
