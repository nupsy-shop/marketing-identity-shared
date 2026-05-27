import { formatBatch, sendBatch } from '../client.js';
import { createForwardProcessor } from '../../common/forward-batch.js';

export default createForwardProcessor('webhook_forward_batch', { formatBatch, sendBatch });
