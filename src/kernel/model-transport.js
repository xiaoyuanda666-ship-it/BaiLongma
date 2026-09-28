import OpenAI from 'openai'

// Own SDK resources without exposing clients to the agent policy layer. Connection
// settings are supplied by the caller; the kernel never reads application config.
export function createModelTransport({ createClient = options => new OpenAI(options) } = {}) {
  let client = null
  let activeConnection = null

  return Object.freeze({
    async openStream({ connection, protocol, params, signal }) {
      if (protocol !== 'responses' && protocol !== 'chat-completions') {
        throw new Error(`Unsupported model transport protocol: ${protocol}`)
      }
      const { provider, baseURL, apiKey } = connection
      if (!client || !activeConnection
        || activeConnection.provider !== provider
        || activeConnection.baseURL !== baseURL
        || activeConnection.apiKey !== apiKey) {
        const nextClient = createClient({ apiKey, baseURL })
        client = nextClient
        activeConnection = { provider, baseURL, apiKey }
      }
      // Return the raw async iterable; interpretation, idle deadlines and retry
      // decisions remain with Runtime. Preserve SDK errors and abort identity.
      return protocol === 'responses'
        ? client.responses.create(params, { signal })
        : client.chat.completions.create(params, { signal })
    },
  })
}
