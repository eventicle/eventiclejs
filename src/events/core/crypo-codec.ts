import * as uuid from "uuid";
import * as crypt from "crypto-js";
import logger from "../../logger";
import { dataStore } from "../..";
import { EventicleEvent, EventClientCodec, EncodedEvent } from "./event-client";

let cryptoConfig: CryptoCodecConfiguration;

const DOMAIN_CRYPTO_KEY = "domain-crypto-key";

export async function setCryptoConfig(config: CryptoCodecConfiguration) {
    cryptoConfig = config
}

export async function getCryptoConfig() {
    return cryptoConfig;
}

export async function provisionCryptoForDomainIdForUser(dsWorkspace: string, domainId: string, userType: string, userId: string, ) {

  const entityName = userType + "-crypto-key";
  let key = await dataStore().findEntity(dsWorkspace, entityName, {userId})

  let theKey

  if (key.length == 0) {
    logger.info(`Provision new crypto key for ${userType}: ${userId}`)
    theKey = uuid.v4().toString()
    await dataStore().createEntity(dsWorkspace, entityName, {
      userId, key: theKey
    })
  } else {
    theKey = key[0].content.key
  }

  let domainKey = await dataStore().findEntity(dsWorkspace, DOMAIN_CRYPTO_KEY, {domainId})

  if (domainKey.length == 0) {
    await dataStore().createEntity(dsWorkspace, DOMAIN_CRYPTO_KEY, {
      domainId, userId, key: theKey
    })
  } else {
    logger.info("Attempting to reprovision a crypto key for the domainId, it is already provisioned ", JSON.stringify({
      domainId, userId, existingDBId: domainKey[0].id
    }))
  }
}

export async function getCryptoKeyForDomainId(dsWorkspace: string, domainId: string) {
  let key = await dataStore().findEntity(dsWorkspace, DOMAIN_CRYPTO_KEY, {domainId})

  let theKey

  if (key.length == 0) {
    logger.warn("Crypto failure, unable to find crypto key for domainId " + domainId)
    return null
  } else {
    theKey = key[0].content.key
  }

  return theKey;
}

export interface CryptoCodecConfiguration {
  [key: string] : string[]
}

export function encryptData(key: string, value: any) {
  return crypt.AES.encrypt(JSON.stringify(value), key).toString()
}

/**
 * Strip any sensitive fields from the event.
 * No crypto included
 */
 export function removePIIFromEvent<T extends EventicleEvent>(ev: T): T {
    if (cryptoConfig.hasOwnProperty(ev.type)) {
      for (let property of cryptoConfig[ev.type]) {
        ev.data[property] = ""
      }
    }
    return ev
  }


export class EventClientCryptoCodec implements EventClientCodec {

  constructor(readonly config: CryptoCodecConfiguration, readonly delegate: EventClientCodec, readonly dsWorkspace: string) {}

  async decode(encoded: EncodedEvent): Promise<EventicleEvent> {
    let event = await this.delegate.decode(encoded)

    if (this.config.hasOwnProperty(event.type)) {
      let key = await getCryptoKeyForDomainId(this.dsWorkspace, event.domainId)
      for (let property of this.config[event.type]) {
        if (key) {
          event.data[property] = crypt.AES.decrypt(event.data[property], key).toString(crypt.enc.Utf8)
        } else {
          event.data[property] = ""
        }
      }
    }

    return event
  }

  async encode(event: EventicleEvent): Promise<EncodedEvent> {
    let data = JSON.parse(JSON.stringify(event)) as EventicleEvent

    if (this.config.hasOwnProperty(event.type)) {
      let key = await getCryptoKeyForDomainId(this.dsWorkspace, event.domainId)
      for (let property of this.config[event.type]) {
        data.data[property] = crypt.AES.encrypt(event.data[property], key).toString()
      }
    }
    return this.delegate.encode(data)
  }
}
