const logger = require('./logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Sends messages one at a time with a randomized delay between them.
// Pauses automatically while the WhatsApp client is not ready, and retries
// failed sends up to maxRetries before giving up.
class SendQueue {
  constructor({ sender, mediaSender, isReady, minDelayMs, maxDelayMs, maxRetries }) {
    this.sender = sender;
    this.mediaSender = mediaSender;
    this.isReady = isReady;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxRetries = maxRetries;
    this.queue = [];
    this.processing = false;
    this.seq = 0;
  }

  enqueue(to, message) {
    const id = `msg_${Date.now()}_${++this.seq}`;
    this.queue.push({ id, to, message, attempts: 0 });
    logger.info(`[QUEUE] queued ${id} -> ${to} (size ${this.queue.length})`);
    this._process();
    return id;
  }

  // Enqueue a media/document send. media = { base64, mimetype, filename, caption }
  enqueueMedia(to, media) {
    const id = `med_${Date.now()}_${++this.seq}`;
    this.queue.push({ id, to, media, attempts: 0 });
    logger.info(`[QUEUE] queued ${id} (media: ${media && media.filename}) -> ${to} (size ${this.queue.length})`);
    this._process();
    return id;
  }

  size() {
    return this.queue.length;
  }

  async _process() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      if (!this.isReady()) {
        await sleep(2000);
        continue;
      }

      const job = this.queue[0];
      try {
        logger.info(`[QUEUE] sending ${job.id} -> ${job.to}`);
        if (job.media) {
          await this.mediaSender(job.to, job.media);
        } else {
          await this.sender(job.to, job.message);
        }
        this.queue.shift();
        logger.info(`[QUEUE] sent ${job.id} -> ${job.to}`);
        if (this.queue.length > 0) {
          await sleep(randBetween(this.minDelayMs, this.maxDelayMs));
        }
      } catch (err) {
        job.attempts += 1;
        logger.error(`[QUEUE] failed ${job.id} -> ${job.to} (attempt ${job.attempts}/${this.maxRetries}): ${err.message}`);
        if (job.attempts >= this.maxRetries) {
          this.queue.shift();
          logger.error(`[QUEUE] giving up on ${job.id} -> ${job.to}`);
        } else {
          await sleep(randBetween(this.minDelayMs, this.maxDelayMs) * job.attempts);
        }
      }
    }

    this.processing = false;
  }
}

module.exports = SendQueue;
