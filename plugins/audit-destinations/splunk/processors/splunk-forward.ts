import { formatBatch, sendBatch } from '../client.js';
import { createForwardProcessor } from '../../common/forward-batch.js';

export default createForwardProcessor('splunk_forward_batch', { formatBatch, sendBatch });
