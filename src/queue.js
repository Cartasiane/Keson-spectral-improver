'use strict'

function createTaskQueue(desiredConcurrency, maxQueueSize = Infinity) {
  const limit = Number.isFinite(desiredConcurrency) && desiredConcurrency > 0
    ? desiredConcurrency
    : Infinity
  const queueLimit = Number.isFinite(maxQueueSize) && maxQueueSize >= 0
    ? maxQueueSize
    : Infinity
  let active = 0
  const queue = []

  const runNext = () => {
    if (active >= limit || queue.length === 0) {
      return
    }
    const { task, resolve, reject } = queue.shift()
    active += 1
    Promise.resolve()
      .then(task)
      .then(result => {
        active -= 1
        resolve(result)
        runNext()
      })
      .catch(error => {
        active -= 1
        reject(error)
        runNext()
      })
  }

  return {
    add(task) {
      if (queue.length >= queueLimit) {
        const error = new Error('Download queue is full.')
        error.code = 'QUEUE_FULL'
        return Promise.reject(error)
      }

      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject })
        runNext()
      })
    }
  }
}

module.exports = { createTaskQueue }
