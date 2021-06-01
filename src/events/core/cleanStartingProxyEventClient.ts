import {eventClient, EventClient, EventSubscriptionControl} from "./event-client";
import logger from "../../logger";
import {getKafkaClient} from "./eventclient-kafka";

export async function cleanStartingProxyEventClient(createClient: () => Promise<EventClient>): Promise<EventClient> {

  const subscriptionOps = [] as ((client: EventClient) => Promise<void>)[]
  let keepConnnecting = true;

  let delegateClient: EventClient = {
    emit: event => Promise.reject(new Error("Event Client is not Connected")),
    coldHotStream: config => {
      let subControl: EventSubscriptionControl

      subscriptionOps.push(async client => {
        subControl = await client.coldHotStream(config)
      })

      return Promise.resolve({
        close: () => {
          if (!subControl) {
            logger.warn("Attempted to close coldHot subscription, but the event client has not yet successfully connected. This is a no-op")
            return
          }
          return subControl.close()
        }
      })
    },
    coldStream: (stream, handler, onError, onDone) => {
      let subControl: EventSubscriptionControl

      subscriptionOps.push(async client => {
        subControl = await client.coldStream(stream, handler, onError, onDone)
      })

      return Promise.resolve({
        close: () => {
          if (!subControl) {
            logger.warn("Attempted to close cold subscription, but the event client has not yet successfully connected. This is a no-op")
            return
          }
          return subControl.close()
        }
      })
    },
    hotRawStream: (stream, consumerName, handler, onError) => {
      let subControl: EventSubscriptionControl

      subscriptionOps.push(async client => {
        subControl = await client.hotRawStream(stream, consumerName, handler, onError)
      })

      return Promise.resolve({
        close: () => {
          if (!subControl) {
            logger.warn("Attempted to close hot subscription, but the event client has not yet successfully connected. This is a no-op")
            return
          }
          return subControl.close()
        }
      })
    },
    hotStream: (stream, consumerName, handler, onError) => {
      let subControl: EventSubscriptionControl

      subscriptionOps.push(async client => {
        subControl = await client.hotStream(stream, consumerName, handler, onError)
      })

      return Promise.resolve({
        close: () => {
          if (!subControl) {
            logger.warn("Attempted to close hot subscription, but the event client has not yet successfully connected. This is a no-op")
            return
          }
          return subControl.close()
        }
      })
    },
    isConnected: () => false,
    shutdown: async () => {
      logger.warn("Shutdown called before cleanStartingProxyEventClient connected. Will give up trying to connect")
      keepConnnecting = false
    }
  }

  try {
    if (keepConnnecting) delegateClient = await createClient()
  } catch (e) {
    logger.warn("Unable to create eventClient due to an error, no-op proxy in effect till it connects", e)
    let interval
    interval = setInterval(async () => {
      if (!keepConnnecting) {
        clearInterval(interval)
        return
      }
      try {
        delegateClient = await createClient()
        clearInterval(interval)
        logger.warn("eventClient has successfully connected, connecting event streams and starting normal operation")
        await Promise.all(subscriptionOps.map(value => value(delegateClient)))
      } catch (e) {
        logger.warn("Unable to create eventClient due to an error, no-op proxy still in effect till it connects", e)
      }
    }, 30000)
  }

  return {
    emit: (event, stream) => delegateClient.emit(event, stream),
    coldHotStream: config => delegateClient.coldHotStream(config),
    hotRawStream: (stream, consumerName, handler, onError) => delegateClient.hotRawStream(stream, consumerName, handler, onError),
    coldStream: (stream, handler, onError, onDone) => delegateClient.coldStream(stream, handler, onError, onDone),
    hotStream: (stream, consumerName, handler, onError) => delegateClient.hotStream(stream, consumerName, handler, onError),
    shutdown: () => delegateClient.shutdown(),
    isConnected: () => delegateClient.isConnected()
  }
}
