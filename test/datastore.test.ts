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

  it('ARRAY_CONTAINS raw types', async function () {
    await standardData()
    const ret = await dataStore().findEntity("first", "first", {
      arrayVal: {
        op: "ARRAY_CONTAINS",
        value: "three"
      }
    })
    expect(ret.length).toBe(3)
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
  it('ARRAY_CONTAINS flat object types', async function () {
    await standardData()
    const ret = await dataStore().findEntity("first", "first", {
      arrayComplexVal: {
        op: "ARRAY_CONTAINS",
        value: { type: "one", flag: true }
      }
    })
    expect(ret.length).toBe(2)
    expect(ret.map((value: any) => value.content))
      .toStrictEqual(expect.arrayContaining([
        expect.objectContaining({
          ide: "first"
        }),
        expect.objectContaining({
          ide: "two"
        })
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

  it("DELETE many", async () => {
    await standardData()
    await dataStore().deleteMany("first", "first", {})
    const ret = await dataStore().findEntity("first", "first", {})
    expect(ret.length).toBe(0)
  })
})


async function standardData() {
  await dataStore().createEntity("first", "first", {
    ide: "first",
    val: 100,
    arrayVal: ["one", "two"],
    arrayComplexVal: [{ type: "one", flag: true}, { type: "two", flag: true }, { type: "three", flag: false }],
    nestedVal: {
      secondLayer: "some layer",
      secondArray: ["sour", "anger", "data"]
    }
  })
  await dataStore().createEntity("first", "first", {
    ide: "two",
    val: 101,
    arrayVal: ["one", "four"],
    arrayComplexVal: [{ type: "two", flag: true }, { type: "one", flag: true}, { type: "two", flag: false }],
    nestedVal: {
      secondLayer: "lazy value",
      secondArray: ["eight", "sixteen"]
    }
  })
  await dataStore().createEntity("first", "first", {
    ide: "three",
    val: 102,
    arrayVal: ["two", "three"],
    arrayComplexVal: [{ type: "two", flag: true }],
  })
  await dataStore().createEntity("first", "first", {
    ide: "four",
    val: 103,
    arrayVal: ["one", "three"],
    arrayComplexVal: [{ type: "two", flag: false }],
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
