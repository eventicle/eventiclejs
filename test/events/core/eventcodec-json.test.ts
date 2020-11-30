import {setDataStore} from "../../../src/datastore";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import {testDbPurge} from "../../../src/fixture";
import {eventClient, eventClientOnDatastore, setEventClient, setEventClientCodec} from "../../../src";
import {eventClientCodec} from "../../../src/events/core/event-client";

describe('Event Codec JSON', function() {

  it('correctly encodes and decodes', async function() {
    let data = await eventClientCodec().encode({
      type: "event.created",
      data: {
        name: "epic", fool: "you", num: 15000
      },
      domainId: "11111",
      id: "fake-uuid"
    })

    let decoded = await eventClientCodec().decode(data)

    console.log(decoded)

  })

})
