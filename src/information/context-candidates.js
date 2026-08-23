import { getDB } from '../db/connection.js'
import { getInformationEvent } from './repositories/events.js'
import { getInformationRoute } from './repositories/routes.js'
import { listInformationDeliveries } from './repositories/deliveries.js'

export function hydrateInformationDeliveryCandidates(deliveries = [], { db = getDB() } = {}) {
  const events = new Map()
  const routes = new Map()
  const candidates = []
  for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
    if (!delivery?.eventId || !delivery?.routeId) continue
    if (!events.has(delivery.eventId)) {
      events.set(delivery.eventId, getInformationEvent(delivery.eventId, { db }))
    }
    if (!routes.has(delivery.routeId)) {
      routes.set(delivery.routeId, getInformationRoute(delivery.routeId, { db }))
    }
    const event = events.get(delivery.eventId)
    const route = routes.get(delivery.routeId)
    if (!event || !route) continue
    candidates.push({ event, route, delivery })
  }
  return candidates
}

export function loadInformationDeliveryCandidates({
  eventId = '',
  subscriberType = '',
  subscriberId = '',
  state = '',
  limit = 100,
} = {}, { db = getDB() } = {}) {
  const deliveries = listInformationDeliveries({
    eventId,
    subscriberType,
    subscriberId,
    state,
    limit,
  }, { db })
  return hydrateInformationDeliveryCandidates(deliveries, { db })
}
