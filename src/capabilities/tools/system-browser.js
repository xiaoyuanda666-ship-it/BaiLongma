// Legacy tool name routes to the same selected Chrome; never launches a second browser.
export async function execSystemBrowserOpen(args = {}, context = {}) {
  const { executeBuiltInChromeTool } = await import('../../mcp/client-manager.js')
  return executeBuiltInChromeTool('browser_navigate', args, context)
}
