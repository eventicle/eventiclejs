import {ThrottledProducer} from '../../../src/events/core/kafka-throttle';
import {HealthCheckStatus} from "../../../src/events/core/eventclient-kafka";
import {Kafka, Message} from "kafkajs";

jest.mock('../../../src/events/core/kafka-throttle', () => {
    const actualModule = jest.requireActual('../../../src/events/core/kafka-throttle');
    return {
        ...actualModule,
        maybeCreateTopic: jest.fn(),
        pause: jest.fn(),
        uuid: {
            v4: jest.fn(() => 'mock-uuid'),
        },
    };
});

describe('ThrottledProducer', () => {

  jest.setTimeout(30000);

    let kafka: any;
    let producerConfig: Record<string, any>;
    let producerHealth: HealthCheckStatus;
    let onTopicFailure: jest.Mock;
    let throttledProducer: ThrottledProducer;

  jest.mock('kafkajs', () => {
    const KafkaProducerMock = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      sendBatch: jest.fn().mockResolvedValue(undefined),
      on: jest.fn()
    };

    return {
      Kafka: jest.fn().mockImplementation(() => ({
        producer: jest.fn().mockReturnValue(KafkaProducerMock),
        consumer: jest.fn(), // Add mockConsumer here if needed later
      })),
      logLevel: {
        ERROR: 0,
        WARN: 1,
        INFO: 2,
        DEBUG: 3,
      }
    };
  });
    beforeEach(() => {
        kafka = new Kafka({clientId: 'test-client', brokers: ['localhost:9092']});
        producerConfig = {maxOutgoingBatchSize: 10, flushIntervalMs: 50};
        producerHealth = {name: 'test-producer', status: 'disconnected', healthy: false};
        onTopicFailure = jest.fn().mockResolvedValue({createTopic: true});
        throttledProducer = new ThrottledProducer(kafka, producerConfig, producerHealth, onTopicFailure);

        jest.spyOn(kafka, 'producer').mockReturnValue({
            connect: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            sendBatch: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
        } as any);
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('should throw an error if send is called without connect', async () => {
        const event: Message[] = [{value: 'test-message'}];
        const stream = 'test-stream';

        await expect(throttledProducer.send(event, stream)).rejects.toThrow(
            'You must connect before producing actions',
        );
    });

    it('should call connect and set proper health status', async () => {
        await throttledProducer.connect();

        expect(throttledProducer['producer'].connect).toHaveBeenCalledTimes(1);
        expect(producerHealth.status).toBe('connected');
        expect(producerHealth.healthy).toBe(true);
    });

    it('should call send and add messages to the recordQueue', async () => {
        jest.spyOn(throttledProducer, 'flush' as any).mockImplementation(() => Promise.resolve());

        await throttledProducer.connect();
        const event: Message[] = [{value: 'message-1'}];
        const stream = 'test-stream';

        await throttledProducer.send(event, stream);

        expect(onTopicFailure).toHaveBeenCalledWith(stream);
        expect(throttledProducer['recordQueue'].length).toBe(1);
        expect(throttledProducer['recordQueue'][0].record).toEqual({
            topic: stream,
            messages: event,
        });
    });

    it('should flush records from the queue in batches', async () => {
        const sendBatchMock = jest.spyOn(throttledProducer['producer'], 'sendBatch');
        await throttledProducer.connect();

        const events: Message[] = Array.from({length: 25}, (_, i) => ({value: `msg-${i}`}));
        const stream = 'flush-stream';

        for (const event of events) {
            await throttledProducer.send([event], stream);
        }

        await throttledProducer['flush']();
        expect(sendBatchMock).toHaveBeenCalledTimes(1);
        expect(sendBatchMock).toHaveBeenCalledWith({
            topicMessages: expect.any(Array),
            acks: -1,
            compression: expect.any(Number),
        });
        expect(throttledProducer['recordQueue'].length).toBe(15); // 10 sent, 15 remaining
    });

    it('should retry sending on UNKNOWN_PRODUCER_ID error', async () => {
        const error = {type: 'UNKNOWN_PRODUCER_ID'};
        const disconnectMock = jest.spyOn(throttledProducer['producer'], 'disconnect').mockResolvedValue(undefined);
        const connectMock = jest.spyOn(throttledProducer['producer'], 'connect').mockResolvedValue(undefined);
        jest.spyOn(throttledProducer['producer'], 'sendBatch').mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

        await throttledProducer.connect();
        const event: Message[] = [{value: 'retry-message'}];
        const stream = 'retry-stream';

        await throttledProducer.send(event, stream);
        await throttledProducer['flush']();

        expect(disconnectMock).toHaveBeenCalledTimes(1);
        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(throttledProducer['producer'].sendBatch).toHaveBeenCalledTimes(2);
    });

    it('should handle topic creation on UNKNOWN_TOPIC_OR_PARTITION error', async () => {
        const error = {type: 'UNKNOWN_TOPIC_OR_PARTITION'};
        const maybeCreateTopic = require('../../../src/events/core/kafka-throttle').maybeCreateTopic;
        jest.spyOn(throttledProducer['producer'], 'sendBatch').mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

        await throttledProducer.connect();
        const event: Message[] = [{value: 'unknown-topic-message'}];
        const stream = 'unknown-topic-stream';

        await throttledProducer.send(event, stream);
        await throttledProducer['flush']();

        expect(onTopicFailure).toHaveBeenCalledWith(stream);
        expect(maybeCreateTopic).toHaveBeenCalledTimes(1);
        expect(throttledProducer['producer'].sendBatch).toHaveBeenCalledTimes(2);
    });

    it('should clean up and disconnect properly', async () => {
        jest.spyOn(global, 'clearInterval');
        await throttledProducer.connect();
        await throttledProducer.disconnect();

        expect(clearInterval).toHaveBeenCalledWith(throttledProducer['intervalTimeout']);
        expect(throttledProducer['producer'].disconnect).toHaveBeenCalledTimes(1);
    });
});
