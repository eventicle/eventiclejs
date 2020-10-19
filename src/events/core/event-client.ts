/**
 * Low level event stream client
 */

let EVENT_CLIENT: EventClient

export function setEventClient(cl: EventClient) {
    EVENT_CLIENT = cl
}

export function eventClient(): EventClient {
    return EVENT_CLIENT
}

export interface EventicleEvent {
    domainId?: string
    id?: string
    date?: string,
    type: string
    data: any
}

export interface EventSubscriptionControl {
    close: () => Promise<void>
}

export interface EventClient {
    /**
     *
     * @param event
     * @param stream
     */
    emit: (event: EventicleEvent[], stream: string) => Promise<void>
    /**
     * Play from persisted storage
     * @param stream
     * @param from
     * @param handler
     * @param onError
     * @param onDone
     */
    coldStream: (stream: string,
                 handler: (event: EventicleEvent) => Promise<void>,
                 onError: (error: any) => void,
                 onDone: () => void) => Promise<EventSubscriptionControl>
    /**
     * Only play hot data.
     * @param stream
     * @param consumerName
     * @param handler
     * @param onError
     */
    hotStream: (stream: string,
                consumerName: string,
                handler: (event: EventicleEvent) => Promise<void>,
                onError: (error: any) => void) => Promise<EventSubscriptionControl>

    /**
     * Play from persisted storage the continue from in memory
     * @param stream
     * @param from
     * @param handler
     * @param onError
     * @param onDone
     */
    coldHotStream: (config: {
        stream: string,
        groupId?: string,
        handler: (event: EventicleEvent) => Promise<void>,
        onError: (error: any) => void
    }) => Promise<EventSubscriptionControl>
}

