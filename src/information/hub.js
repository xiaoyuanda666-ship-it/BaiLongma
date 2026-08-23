import { getDB } from '../db/connection.js'
import { createInformationItem } from './envelope.js'
import { informationRouteMatches } from './subscription-matcher.js'
import { insertInformationEvent } from './repositories/events.js'
import { listInformationRoutes } from './repositories/routes.js'
import { createInformationDelivery } from './repositories/deliveries.js'

export function publishInformationEvent(input, { db = getDB() } = {}) {
  const item = createInformationItem(input)
  const publish = db.transaction(() => {
    const persisted = insertInformationEvent(item, { db })
    if (!persisted.created) {
      return {
        created: false,
        event: persisted.event,
        matchedRouteIds: [],
        deliveries: [],
      }
    }

    const matchedRoutes = listInformationRoutes({ enabledOnly: true }, { db })
      .filter(route => informationRouteMatches(route, persisted.event))
    const deliveries = matchedRoutes.map(route => (
      createInformationDelivery({ event: persisted.event, route }, { db }).delivery
    )).filter(Boolean)
    return {
      created: true,
      event: persisted.event,
      matchedRouteIds: matchedRoutes.map(route => route.id),
      deliveries,
    }
  })
  return publish()
}
