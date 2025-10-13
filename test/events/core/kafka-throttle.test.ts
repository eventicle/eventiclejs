import {ThrottledProducer} from '../../../src/events/core/kafka-throttle';
import {Kafka, Message} from "kafkajs";
import type {HealthCheckStatus} from "../../../src/events/core/eventclient-kafka";

describe('ThrottledProducer', () => {

  jest.setTimeout(30000);

    let kafka: any;
    let producerConfig: Record<string, any>;
    let producerHealth: HealthCheckStatus;
    let onTopicFailure: jest.Mock;
    let throttledProducer: ThrottledProducer;
    let mockProducer: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockProducer = {
            connect: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            sendBatch: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
        };

        kafka = {
            producer: jest.fn().mockReturnValue(mockProducer),
            admin: jest.fn().mockReturnValue({
                connect: jest.fn().mockResolvedValue(undefined),
                disconnect: jest.fn().mockResolvedValue(undefined),
                listTopics: jest.fn().mockResolvedValue([]),
                createTopics: jest.fn().mockResolvedValue(undefined),
            }),
        } as any;

        producerConfig = {maxOutgoingBatchSize: 10, flushIntervalMs: 50};
        producerHealth = {name: 'test-producer', status: 'disconnected', healthy: false};
        onTopicFailure = jest.fn().mockResolvedValue({createTopic: false});

        throttledProducer = new ThrottledProducer(kafka, producerConfig, producerHealth, onTopicFailure);
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

        expect(mockProducer.connect).toHaveBeenCalledTimes(1);
        expect(mockProducer.on).toHaveBeenCalled();
        expect(producerHealth.status).toBe('disconnected');
    });

    it('should call send and add messages to the recordQueue', async () => {
        await throttledProducer.connect();
        const event: Message[] = [{value: 'message-1'}];
        const stream = 'test-stream';

        // send() is async and awaits maybeCreateTopic before queuing
        const sendPromise = throttledProducer.send(event, stream);

        // Wait for send to complete its setup (maybeCreateTopic)
        await new Promise(resolve => setImmediate(resolve));

        expect(onTopicFailure).toHaveBeenCalledWith(stream);
        expect(throttledProducer['recordQueue'].length).toBe(1);
        expect(throttledProducer['recordQueue'][0].record).toEqual({
            topic: stream,
            messages: event,
        });

        // Manually flush to resolve the promise
        await throttledProducer['flush']();
        await sendPromise;
    });

    it('should flush records from the queue in batches', async () => {
        await throttledProducer.connect();

        const events: Message[] = Array.from({length: 25}, (_, i) => ({value: `msg-${i}`}));
        const stream = 'flush-stream';

        const promises = [];
        for (const event of events) {
            promises.push(throttledProducer.send([event], stream));
        }

        // Wait for all send() calls to complete their setup
        await new Promise(resolve => setImmediate(resolve));

        // onTopicFailure should only be called once for the same stream
        expect(onTopicFailure).toHaveBeenCalledTimes(1);
        expect(onTopicFailure).toHaveBeenCalledWith(stream);

        await throttledProducer['flush']();
        expect(mockProducer.sendBatch).toHaveBeenCalledTimes(1);
        expect(mockProducer.sendBatch).toHaveBeenCalledWith({
            topicMessages: expect.any(Array),
            acks: -1,
            compression: expect.any(Number),
        });
        expect(throttledProducer['recordQueue'].length).toBe(15); // 10 sent, 15 remaining
    });

    it('should retry sending on UNKNOWN_PRODUCER_ID error', async () => {
        const error = {name: 'KafkaJSProtocolError', type: 'UNKNOWN_PRODUCER_ID', retriable: true, code: 59};
        mockProducer.sendBatch.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);

        await throttledProducer.connect();
        const event: Message[] = [{value: 'retry-message'}];
        const stream = 'retry-stream';

        await throttledProducer.send(event, stream);
        await throttledProducer['flush']();

        expect(mockProducer.disconnect).toHaveBeenCalledTimes(1);
        expect(kafka.producer).toHaveBeenCalledTimes(2); // once in constructor, once in retry
        expect(mockProducer.sendBatch).toHaveBeenCalledTimes(2);
    });

    it('should handle topic creation on UNKNOWN_TOPIC_OR_PARTITION error', async () => {
        const error = {name: 'KafkaJSProtocolError', type: 'UNKNOWN_TOPIC_OR_PARTITION', retriable: true, code: 3};
        mockProducer.sendBatch.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
        // Set to false to avoid calling kafka.admin() which requires real kafka instance
        onTopicFailure.mockResolvedValue({createTopic: false});

        await throttledProducer.connect();
        const event: Message[] = [{value: 'unknown-topic-message'}];
        const stream = 'unknown-topic-stream';

        await throttledProducer.send(event, stream);
        await throttledProducer['flush']();

        expect(onTopicFailure).toHaveBeenCalledWith(stream);
        // Verify retry happened after UNKNOWN_TOPIC_OR_PARTITION
        expect(mockProducer.sendBatch).toHaveBeenCalledTimes(2);
    });

    it('should clean up and disconnect properly', async () => {
        jest.spyOn(global, 'clearInterval');
        await throttledProducer.connect();
        await throttledProducer.disconnect();

        expect(clearInterval).toHaveBeenCalledWith(throttledProducer['intervalTimeout']);
        expect(mockProducer.disconnect).toHaveBeenCalledTimes(1);
    });
});
