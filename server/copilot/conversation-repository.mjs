export class ConversationRepository {
  constructor({ store } = {}) { if (!store) throw new TypeError('Conversation repository requires a store.'); this.store = store; }
  create(reference, value) { return this.store.createConversation(reference, value); }
  get(reference) { return this.store.getConversation(reference); }
  update(reference, patch, options) { return this.store.updateConversation(reference, patch, options); }
  listMessages(reference, options) { return this.store.listMessages(reference, options); }
  listRuns(reference, options) { return this.store.listRuns(reference, options); }
  appendMessage(reference, value) { return this.store.appendMessage(reference, value); }
  appendRun(reference, value, options) { return this.store.appendRun(reference, value, options); }
}

export function createConversationRepository(options) { return new ConversationRepository(options); }
