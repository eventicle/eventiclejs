import {dataStore, setDataStore} from "../src";
import InMemDatastore from "../src/datastore/inmem-data-store";
import {testDbPurge} from "../src/fixture";

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

    expect(ret.map((value: any) => value.content)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ide: "four",
          val: 103
        })
      ])
    )
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

    expect(ret.map((value: any) => value.content))
      .toStrictEqual(expect.arrayContaining([
        expect.objectContaining({
          ide: "four",
          val: 103
        }),
        expect.objectContaining({
          ide: "five",
          val: 104
        })
      ]))
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

    expect(ret.map((value: any) => value.content)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ide: "five",
          val: 104
        })
      ]))
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

    expect(ret.map((value: any) => value.content)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ide: "first",
          val: 100
        }),
        expect.objectContaining({
          ide: "two",
          val: 101
        }),
        expect.objectContaining({
          ide: "three",
          val: 102
        })
      ]))
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

    expect(ret.map((value: any) => value.content)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ide: "first",
          val: 100
        }),
        expect.objectContaining({
          ide: "two",
          val: 101
        }),
        expect.objectContaining({
          ide: "three",
          val: 102
        })
      ]))
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

    expect(ret.map((value: any) => value.content)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ide: "two",
          val: 101
        }),
        expect.objectContaining({
          ide: "three",
          val: 102
        }),
        expect.objectContaining({
          ide: "four",
          val: 103
        })
      ]))
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

    expect(ret.map((value: any) => value.content)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ide: "two",
          val: 101
        }),
        expect.objectContaining({
          ide: "four",
          val: 103
        })
      ]))
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

    expect(ret.map((value: any) => value.content)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ide: "three",
          val: 102
        }),
        expect.objectContaining({
          ide: "two",
          val: 101
        }),
        expect.objectContaining({
          ide: "first",
          val: 100
        })
      ]))
  })
  it('OBJECT', async function () {
    await standardData()
    const ret = await dataStore().findEntity("first", "first", {
      arrayVal: {
        op: "OBJECT",
        value: {arrayVal: ["three"]}
      }
    })

    expect(ret.map((value: any) => value.content))
      .toStrictEqual(expect.arrayContaining([
        expect.objectContaining({
          ide: "three",
          arrayVal: ["two", "three"]
        }),
        expect.objectContaining({
          ide: "four",
          arrayVal: ["one", "three"]
        }),
        expect.objectContaining({
          ide: "five",
          arrayVal: ["four", "two", "three"]
        }),
      ]))
  })

  it("LIKE", async () => {
    await standardData()

    const ret = await dataStore().findEntity("first", "first", {
      first: {
        op: "LIKE",
        value: {
          path: ["nestedVal", "secondArray"],
          like: "our"
        }
      }
    })

    const ret2 = await dataStore().findEntity("first", "first", {
      first: {
        op: "LIKE",
        value: {
          path: ["nestedVal", "secondLayer"],
          like: "value"
        }
      }
    })

    expect(ret.map((value: any) => value.content))
      .toStrictEqual(expect.arrayContaining([
        expect.objectContaining({
          ide: "first",
          arrayVal: ["one", "two"],
        }),
        expect.objectContaining({
          ide: "five",
          arrayVal: ["four", "two", "three"]
        }),
      ]))

    expect(ret2.map((value: any) => value.content))
      .toStrictEqual(expect.arrayContaining([
        expect.objectContaining({
          ide: "two",
          arrayVal: ["one", "four"],
        }),
        expect.objectContaining({
          ide: "five",
          arrayVal: ["four", "two", "three"]
        }),
      ]))
  })
})


async function standardData() {
  await dataStore().createEntity("first", "first", {
    ide: "first",
    val: 100,
    arrayVal: ["one", "two"],
    nestedVal: {
      secondLayer: "some layer",
      secondArray: ["sour", "anger", "data"]
    }
  })
  await dataStore().createEntity("first", "first", {
    ide: "two",
    val: 101,
    arrayVal: ["one", "four"],
    nestedVal: {
      secondLayer: "lazy value",
      secondArray: ["eight", "sixteen"]
    }
  })
  await dataStore().createEntity("first", "first", {
    ide: "three",
    val: 102,
    arrayVal: ["two", "three"]
  })
  await dataStore().createEntity("first", "first", {
    ide: "four",
    val: 103,
    arrayVal: ["one", "three"]
  })
  await dataStore().createEntity("first", "first", {
    ide: "five",
    val: 104,
    arrayVal: ["four", "two", "three"],
    nestedVal: {
      secondLayer: "one value",
      secondArray: ["four", "five", "dour"]
    }
  })
}
