import {InMemoryDatastore, eventClient, setDataStore, setEventClient} from "../src/index";
import {ConsumerConfigFactory, getKafkaClientHealth} from "../src/events/core/eventclient-kafka";
import {eventClientOnKafka} from "../src";
import {cleanStartingProxyEventClient} from "../src/events/core/cleanStartingProxyEventClient";


export function kafkaJsConsumerConfig(): ConsumerConfigFactory {
  return {
    consumerConfig: (stream: any, consumerName: any, type: any) => {
      return {
        maxWaitTimeInMs: 100,
        retry: {
          restartOnFailure: async err => true,
          factor: 2, initialRetryTime: 5000, maxRetryTime: 15000, multiplier: 1.1, retries: Number.MAX_VALUE
        },
        groupId: consumerName
      }
    },
    consumerRunConfig: (stream: any, consumerName: any, type: any) => {
      if (type === "COLD") {
        return {
          autoCommit: true,
          autoCommitInterval: 500,
          autoCommitThreshold: 50
        }
      }
      return {
        autoCommit: true,
        autoCommitInterval: 500,
        autoCommitThreshold: 50,
        partitionsConsumedConcurrently: 50,
      }
    }
  }
}


async function doit() {
  setInterval(() => {
    console.log(getKafkaClientHealth())
  }, 3000)

  try {
    setEventClient(await cleanStartingProxyEventClient(() => eventClientOnKafka({
      clientId: "payment-service", brokers: [
        'localhost:9092'
      ],

    }, kafkaJsConsumerConfig())))

    setDataStore(new InMemoryDatastore());


    await eventClient().coldHotStream({
      stream: "simples", groupId: "my-cool-group", rawEvents:false, handler: async event => {
        console.log("WOOT")
        console.log(event)
      }, onError: error => console.log(error)
    })

    setInterval(async () => {
      await eventClient().emit([{
        domainId: "xxxxxx", data: { }, type: "my.event.awesome", createdAt: Date.now(), id: "xxxxxxx"
      }], "simples")

    }, 10000)

    console.log("YOYOY")
  } catch (e) {
    console.log("FAILED TO CONNECT TO KAFKA IN BOOTUP", e)
  }
}



doit()
