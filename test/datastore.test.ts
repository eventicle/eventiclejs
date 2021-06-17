import {dataStore, setDataStore} from "../src/datastore";
import InMemDatastore from "../src/datastore/inmem-data-store";
import {testDbPurge} from "../src/fixture";
import {eventClient, eventClientOnDatastore, setEventClient} from "../src";

describe('Data Store', function() {

  beforeEach(async () => {
    setDataStore(new InMemDatastore());
    await testDbPurge();
  })

  it('EQ', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: 103,
        op: "EQ"
      }
    }, {
      "val": "ASC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "four",
        val: 103
      }
    ])
  })

  it('GTE', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: 103,
        op: "GTE"
      }
    }, {
      "val": "ASC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "four",
        val: 103
      },
      {
        ide: "five",
        val: 104
      }
    ])
  })

  it('GT', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: 103,
        op: "GT"
      }
    }, {
      "val": "ASC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "five",
        val: 104
      }
    ])
  })

  it('LT', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: 103,
        op: "LT"
      }
    }, {
      "val": "ASC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "first",
        val: 100
      },{
        ide: "two",
        val: 101
      },{
        ide: "three",
        val: 102
      }
    ])
  })

  it('LTE', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: 102,
        op: "LTE"
      }
    }, {
      "val": "ASC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "first",
        val: 100
      },{
        ide: "two",
        val: 101
      },{
        ide: "three",
        val: 102
      }
    ])
  })

  it('BETWEEN', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: [101, 103],
        op: "BETWEEN"
      }
    }, {
      "val": "ASC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "two",
        val: 101
      },{
        ide: "three",
        val: 102
      },{
        ide: "four",
        val: 103
      }
    ])
  })

  it('IN', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: [101, 103],
        op: "IN"
      }
    }, {
      "val": "ASC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "two",
        val: 101
      },{
        ide: "four",
        val: 103
      }
    ])
  })

  it('DESC', async function () {
    await standardData()

    let ret = await dataStore().findEntity("first", "first", {
      val: {
        value: 102,
        op: "LTE"
      }
    }, {
      "val": "DESC"
    })

    expect(ret.map((value: any) => value.content)).toStrictEqual([
      {
        ide: "three",
        val: 102
      },{
        ide: "two",
        val: 101
      },{
        ide: "first",
        val: 100
      }
    ])
  })
})


async function standardData() {
  await dataStore().createEntity("first", "first", {
    ide: "first",
    val: 100
  })
  await dataStore().createEntity("first", "first", {
    ide: "two",
    val: 101
  })
  await dataStore().createEntity("first", "first", {
    ide: "three",
    val: 102
  })
  await dataStore().createEntity("first", "first", {
    ide: "four",
    val: 103
  })
  await dataStore().createEntity("first", "first", {
    ide: "five",
    val: 104
  })
}
