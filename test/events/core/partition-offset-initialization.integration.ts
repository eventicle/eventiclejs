import {
  eventClient,
  EventicleEvent,
  setEventClient,
} from "../../../src/events/core/event-client";
import { testDbPurge } from "../../../src/fixture";
import { eventClientOnKafka, getKafkaClient } from "../../../src/events/core/eventclient-kafka";
import * as uuid from "uuid";
import { pause } from "../../../src/util";
import { setDataStore } from "../../../src";
import InMemDatastore from "../../../src/datastore/inmem-data-store";
import { logger } from "@eventicle/eventicle-utilities";
import { Kafka } from "kafkajs";

jest.setTimeout(120000);

const PARTITION_COUNT = 5;
const TOPIC_NAME = `partition-test-${uuid.v4().substring(0, 8)}`;
const BROKER = "localhost:9092";

let kafka: Kafka;

async function createMultiPartitionTopic(topicName: string, numPartitions: number): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();

  try {
    const existingTopics = await admin.listTopics();
    if (existingTopics.includes(topicName)) {
      await admin.deleteTopics({ topics: [topicName] });
      await pause(2000);
    }

    await admin.createTopics({
      topics: [{
        topic: topicName,
        numPartitions: numPartitions,
        replicationFactor: 1,
      }]
    });

    await pause(2000);

    const metadata = await admin.fetchTopicMetadata({ topics: [topicName] });
    const topicInfo = metadata.topics.find(t => t.name === topicName);
    logger.info(`Created topic ${topicName} with ${topicInfo?.partitions.length} partitions`);
  } finally {
    await admin.disconnect();
  }
}

async function publishToSpecificPartition(
  topicName: string,
  partition: number,
  messageId: string
): Promise<void> {
  const producer = kafka.producer({
    createPartitioner: () => {
      return () => partition;
    }
  });

  await producer.connect();

  try {
    await producer.send({
      topic: topicName,
      messages: [{
        key: `key-${partition}`,
        value: JSON.stringify({
          id: messageId,
          type: "test-event",
          data: { partition, timestamp: Date.now() },
          domainId: `domain-${partition}`,
          createdAt: Date.now()
        }),
        partition: partition
      }]
    });
    logger.info(`Published message ${messageId} to partition ${partition}`);
  } finally {
    await producer.disconnect();
  }
}

async function getConsumerGroupOffsets(groupId: string, topicName: string): Promise<Map<number, string>> {
  const admin = kafka.admin();
  await admin.connect();

  try {
    const offsets = await admin.fetchOffsets({ groupId, topics: [topicName] });
    const partitionOffsets = new Map<number, string>();

    for (const topicOffset of offsets) {
      if (topicOffset.topic === topicName) {
        for (const partitionData of topicOffset.partitions) {
          partitionOffsets.set(partitionData.partition, partitionData.offset);
        }
      }
    }

    return partitionOffsets;
  } finally {
    await admin.disconnect();
  }
}

async function deleteConsumerGroup(groupId: string): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();

  try {
    await admin.deleteGroups([groupId]);
    logger.info(`Deleted consumer group ${groupId}`);
  } catch (error) {
    logger.warn(`Could not delete consumer group ${groupId}`, error);
  } finally {
    await admin.disconnect();
  }
}

beforeAll(async function () {
  const clientId = "partition-test-" + uuid.v4();

  kafka = new Kafka({
    clientId: clientId,
    brokers: [BROKER]
  });

  setDataStore(new InMemDatastore());
  setEventClient(
    await eventClientOnKafka({
      brokers: [BROKER],
      clientId: clientId,
    })
  );

  await testDbPurge();
  await createMultiPartitionTopic(TOPIC_NAME, PARTITION_COUNT);
});

afterAll(async () => {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.deleteTopics({ topics: [TOPIC_NAME] });
  } catch (e) {
    // ignore
  }
  await admin.disconnect();
  await eventClient().shutdown();
});

describe("Partition Offset Initialization", function () {

  describe("PROBLEM DEMONSTRATION: New consumer group with hotStream", function () {

    it("demonstrates that a new consumer group may not receive messages on all partitions initially", async function () {
      const groupId = `new-group-${uuid.v4()}`;
      const receivedEvents: EventicleEvent[] = [];

      const subscription = await eventClient().hotStream({
        stream: TOPIC_NAME,
        groupId: groupId,
        handler: async (event) => {
          receivedEvents.push(event);
          logger.info(`Received event ${event.id} on group ${groupId}`);
        },
        onError: (error) => {
          logger.error("Error in consumer", error);
        }
      });

      await pause(3000);

      const messageIds: string[] = [];
      for (let partitionIndex = 0; partitionIndex < PARTITION_COUNT; partitionIndex++) {
        const msgId = `msg-${partitionIndex}-${uuid.v4()}`;
        messageIds.push(msgId);
        await publishToSpecificPartition(TOPIC_NAME, partitionIndex, msgId);
      }

      await pause(5000);

      const offsets = await getConsumerGroupOffsets(groupId, TOPIC_NAME);
      logger.info(`Consumer group ${groupId} offsets:`, Object.fromEntries(offsets));

      expect(receivedEvents.length).toBe(PARTITION_COUNT);

      await subscription.close();
      await deleteConsumerGroup(groupId);
    });

    it("demonstrates message loss scenario: messages published before consumer restart are lost on partitions without committed offsets", async function () {
      const groupId = `restart-test-${uuid.v4()}`;
      const receivedPhase1: EventicleEvent[] = [];
      const receivedPhase2: EventicleEvent[] = [];

      const subscription1 = await eventClient().hotStream({
        stream: TOPIC_NAME,
        groupId: groupId,
        handler: async (event) => {
          receivedPhase1.push(event);
          logger.info(`Phase 1: Received event ${event.id}`);
        },
        onError: (error) => {
          logger.error("Error in consumer phase 1", error);
        }
      });

      await pause(3000);

      await publishToSpecificPartition(TOPIC_NAME, 0, `phase1-msg-${uuid.v4()}`);

      await pause(3000);

      logger.info(`Phase 1: Received ${receivedPhase1.length} events`);

      const offsetsAfterPhase1 = await getConsumerGroupOffsets(groupId, TOPIC_NAME);
      logger.info("Offsets after phase 1:", Object.fromEntries(offsetsAfterPhase1));

      const partitionsWithCommittedOffset = Array.from(offsetsAfterPhase1.entries())
        .filter(([_, offset]) => offset !== "-1" && parseInt(offset) >= 0)
        .map(([partition, _]) => partition);

      const partitionsWithoutCommittedOffset = Array.from(offsetsAfterPhase1.entries())
        .filter(([_, offset]) => offset === "-1" || parseInt(offset) < 0)
        .map(([partition, _]) => partition);

      logger.info(`Partitions with committed offset: ${partitionsWithCommittedOffset}`);
      logger.info(`Partitions without committed offset: ${partitionsWithoutCommittedOffset}`);

      await subscription1.close();
      logger.info("Consumer disconnected - simulating application restart");

      await pause(2000);

      const messagesPublishedDuringDowntime: { partition: number; messageId: string }[] = [];
      for (let partitionIndex = 0; partitionIndex < PARTITION_COUNT; partitionIndex++) {
        const msgId = `downtime-msg-p${partitionIndex}-${uuid.v4()}`;
        messagesPublishedDuringDowntime.push({ partition: partitionIndex, messageId: msgId });
        await publishToSpecificPartition(TOPIC_NAME, partitionIndex, msgId);
        logger.info(`Published message during downtime to partition ${partitionIndex}: ${msgId}`);
      }

      await pause(1000);

      const subscription2 = await eventClient().hotStream({
        stream: TOPIC_NAME,
        groupId: groupId,
        handler: async (event) => {
          receivedPhase2.push(event);
          logger.info(`Phase 2: Received event ${event.id}`);
        },
        onError: (error) => {
          logger.error("Error in consumer phase 2", error);
        }
      });

      await pause(5000);

      const offsetsAfterPhase2 = await getConsumerGroupOffsets(groupId, TOPIC_NAME);
      logger.info("Offsets after phase 2:", Object.fromEntries(offsetsAfterPhase2));

      logger.info(`Phase 2: Received ${receivedPhase2.length} events`);
      logger.info(`Expected ${PARTITION_COUNT} events (one per partition)`);

      const receivedMessageIds = receivedPhase2.map(e => e.id);
      const publishedMessageIds = messagesPublishedDuringDowntime.map(m => m.messageId);

      const lostMessages = publishedMessageIds.filter(id => !receivedMessageIds.includes(id));
      const receivedMessages = publishedMessageIds.filter(id => receivedMessageIds.includes(id));

      logger.info(`Received messages: ${receivedMessages.length}`);
      logger.info(`Lost messages: ${lostMessages.length}`);

      if (lostMessages.length > 0) {
        logger.warn(`PROBLEM DEMONSTRATED: ${lostMessages.length} messages were lost!`);
        logger.warn(`Lost message IDs: ${lostMessages.join(", ")}`);

        const lostPartitions = messagesPublishedDuringDowntime
          .filter(m => lostMessages.includes(m.messageId))
          .map(m => m.partition);
        logger.warn(`Lost messages were on partitions: ${lostPartitions.join(", ")}`);

        const expectedLostPartitions = partitionsWithoutCommittedOffset;
        logger.info(`These should match partitions without committed offsets: ${expectedLostPartitions.join(", ")}`);
      }

      await subscription2.close();
      await deleteConsumerGroup(groupId);

      if (partitionsWithoutCommittedOffset.length > 0) {
        expect(lostMessages.length).toBeGreaterThan(0);
      }
    });
  });

  describe("FIX: Ensure partition offsets are committed on subscription", function () {

    /**
     * Ensures all partitions of a topic have committed offsets for a consumer group.
     * For partitions without existing committed offsets, sets them to the current high watermark.
     * This prevents message loss when a consumer group is first created or restarted,
     * by ensuring Kafka knows the starting position for ALL partitions, not just those
     * that have processed messages.
     */
    async function ensurePartitionOffsetsCommitted(
      kafka: Kafka,
      groupId: string,
      topicName: string
    ): Promise<void> {
      const admin = kafka.admin();
      await admin.connect();

      try {
        const metadata = await admin.fetchTopicMetadata({ topics: [topicName] });
        const topicInfo = metadata.topics.find(t => t.name === topicName);
        if (!topicInfo) {
          throw new Error(`Topic ${topicName} not found`);
        }

        const partitions = topicInfo.partitions.map(p => p.partitionId);

        const topicOffsets = await admin.fetchTopicOffsets(topicName);

        const existingOffsets = await admin.fetchOffsets({ groupId, topics: [topicName] });
        const existingPartitionOffsets = new Map<number, string>();
        for (const topicOffset of existingOffsets) {
          if (topicOffset.topic === topicName) {
            for (const partitionData of topicOffset.partitions) {
              existingPartitionOffsets.set(partitionData.partition, partitionData.offset);
            }
          }
        }

        const partitionsNeedingInit: { partition: number; offset: string }[] = [];

        for (const partition of partitions) {
          const existingOffset = existingPartitionOffsets.get(partition);
          const isUninitialized = !existingOffset || existingOffset === "-1" || parseInt(existingOffset) < 0;

          if (isUninitialized) {
            const latestOffset = topicOffsets.find(o => o.partition === partition)?.high || "0";
            partitionsNeedingInit.push({
              partition,
              offset: latestOffset
            });
          }
        }

        if (partitionsNeedingInit.length > 0) {
          logger.info(`Initializing offsets for ${partitionsNeedingInit.length} partitions in group ${groupId}:`,
            partitionsNeedingInit);

          await admin.setOffsets({
            groupId,
            topic: topicName,
            partitions: partitionsNeedingInit
          });

          logger.info(`Initialized partition offsets for group ${groupId} on topic ${topicName}`);
        } else {
          logger.debug(`All partitions already have committed offsets for group ${groupId}`);
        }
      } finally {
        await admin.disconnect();
      }
    }

    it("with fix applied: all partitions have committed offsets after initialization", async function () {
      const groupId = `fixed-group-${uuid.v4()}`;

      await ensurePartitionOffsetsCommitted(kafka, groupId, TOPIC_NAME);

      const offsets = await getConsumerGroupOffsets(groupId, TOPIC_NAME);
      logger.info("Offsets after initialization:", Object.fromEntries(offsets));

      for (let partitionIndex = 0; partitionIndex < PARTITION_COUNT; partitionIndex++) {
        const offset = offsets.get(partitionIndex);
        expect(offset).toBeDefined();
        expect(parseInt(offset!)).toBeGreaterThanOrEqual(0);
      }

      await deleteConsumerGroup(groupId);
    });

    it("with fix applied: no messages are lost on restart", async function () {
      const groupId = `fixed-restart-${uuid.v4()}`;
      const receivedPhase1: EventicleEvent[] = [];
      const receivedPhase2: EventicleEvent[] = [];

      await ensurePartitionOffsetsCommitted(kafka, groupId, TOPIC_NAME);

      const subscription1 = await eventClient().hotStream({
        stream: TOPIC_NAME,
        groupId: groupId,
        handler: async (event) => {
          receivedPhase1.push(event);
          logger.info(`Fixed Phase 1: Received event ${event.id}`);
        },
        onError: (error) => {
          logger.error("Error in consumer phase 1", error);
        }
      });

      await pause(3000);

      await publishToSpecificPartition(TOPIC_NAME, 0, `fixed-phase1-${uuid.v4()}`);
      await pause(2000);

      const offsetsAfterPhase1 = await getConsumerGroupOffsets(groupId, TOPIC_NAME);
      logger.info("Fixed: Offsets after phase 1:", Object.fromEntries(offsetsAfterPhase1));

      for (let partitionIndex = 0; partitionIndex < PARTITION_COUNT; partitionIndex++) {
        const offset = offsetsAfterPhase1.get(partitionIndex);
        expect(offset).toBeDefined();
        expect(parseInt(offset!)).toBeGreaterThanOrEqual(0);
        logger.info(`Partition ${partitionIndex} has committed offset: ${offset}`);
      }

      await subscription1.close();
      logger.info("Fixed: Consumer disconnected - simulating restart");

      await pause(2000);

      const messagesPublishedDuringDowntime: { partition: number; messageId: string }[] = [];
      for (let partitionIndex = 0; partitionIndex < PARTITION_COUNT; partitionIndex++) {
        const msgId = `fixed-downtime-p${partitionIndex}-${uuid.v4()}`;
        messagesPublishedDuringDowntime.push({ partition: partitionIndex, messageId: msgId });
        await publishToSpecificPartition(TOPIC_NAME, partitionIndex, msgId);
        logger.info(`Fixed: Published during downtime to partition ${partitionIndex}: ${msgId}`);
      }

      await pause(1000);

      await ensurePartitionOffsetsCommitted(kafka, groupId, TOPIC_NAME);

      const subscription2 = await eventClient().hotStream({
        stream: TOPIC_NAME,
        groupId: groupId,
        handler: async (event) => {
          receivedPhase2.push(event);
          logger.info(`Fixed Phase 2: Received event ${event.id}`);
        },
        onError: (error) => {
          logger.error("Error in consumer phase 2", error);
        }
      });

      await pause(5000);

      logger.info(`Fixed Phase 2: Received ${receivedPhase2.length} events`);

      const receivedMessageIds = receivedPhase2.map(e => e.id);
      const publishedMessageIds = messagesPublishedDuringDowntime.map(m => m.messageId);

      const lostMessages = publishedMessageIds.filter(id => !receivedMessageIds.includes(id));

      logger.info(`Fixed: Received ${receivedPhase2.length} of ${PARTITION_COUNT} expected messages`);
      logger.info(`Fixed: Lost messages: ${lostMessages.length}`);

      expect(receivedPhase2.length).toBe(PARTITION_COUNT);
      expect(lostMessages.length).toBe(0);

      await subscription2.close();
      await deleteConsumerGroup(groupId);
    });
  });
});
