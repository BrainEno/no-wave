import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteConversationStore } from "./sqlite-conversation-store.ts";
import { createSqliteOutboxStore } from "./sqlite-outbox-store.ts";
import { ConversationAccessError, ConversationInputError, IdempotencyConflictError, InvalidMessageCursorError } from "../domain/errors.ts";

async function fixture() {
  const db=createSqliteClient({filename:":memory:",enableWal:false});
  await runSqliteMigrations(db);
  return {db,conversations:createSqliteConversationStore(db),outbox:createSqliteOutboxStore(db)};
}

test("SQLite conversation messages are idempotent, authorized, and enqueue one outbox event", async()=>{
 const {db,conversations}=await fixture();
 try {
  const c=await conversations.createConversation({actorId:"alice",participantIds:["bob"]});
  const msg=await conversations.persistMessage({conversationId:c.id,senderId:"alice",body:"hello",idempotencyKey:"key-1"});
  const dup=await conversations.persistMessage({conversationId:c.id,senderId:"alice",body:"hello",idempotencyKey:"key-1"});
  assert.equal(msg.duplicate,false); assert.equal(dup.duplicate,true); assert.equal(dup.id,msg.id);
  assert.equal(db.prepare("SELECT count(*) n FROM outbox_events").get().n,1);
  await assert.rejects(conversations.persistMessage({conversationId:c.id,senderId:"alice",body:"different",idempotencyKey:"key-1"}),IdempotencyConflictError);
  await assert.rejects(conversations.persistMessage({conversationId:c.id,senderId:"intruder",body:"no",idempotencyKey:"key-2"}),ConversationAccessError);
  assert.deepEqual(await conversations.listConversationParticipantIds({conversationId:c.id}),["alice","bob"]);
 } finally {db.close();}
});

test("SQLite conversation history supports cursor paging and unread/read state", async()=>{
 const {db,conversations}=await fixture();
 try {
  const c=await conversations.createConversation({actorId:"alice",participantIds:["bob"]});
  const first=await conversations.persistMessage({conversationId:c.id,senderId:"alice",body:"one",idempotencyKey:"1"});
  await new Promise(resolve=>setTimeout(resolve,3));
  const second=await conversations.persistMessage({conversationId:c.id,senderId:"bob",body:"two",idempotencyKey:"2"});
  const list=await conversations.listConversationMessages({conversationId:c.id,actorId:"alice",limit:1});
  assert.equal(list[0].id,second.id);
  const older=await conversations.listConversationMessages({conversationId:c.id,actorId:"alice",limit:10,before:second.id});
  assert.deepEqual(older.map(m=>m.id),[first.id]);
  const conv=(await conversations.listConversations({actorId:"alice"}))[0];
  assert.equal(conv.lastMessage.id,second.id); assert.equal(conv.unreadCount,1);
  await conversations.markConversationAsRead({conversationId:c.id,actorId:"alice"});
  assert.equal((await conversations.listConversations({actorId:"alice"}))[0].unreadCount,0);
  await assert.rejects(conversations.listConversationMessages({conversationId:c.id,actorId:"alice",before:randomUUID()}),InvalidMessageCursorError);
 } finally {db.close();}
});

test("SQLite conversation participant changes require creator and preserve creator membership",async()=>{
 const {db,conversations}=await fixture();
 try {
  const c=await conversations.createConversation({actorId:"alice",participantIds:["bob"]});
  await assert.rejects(conversations.updateConversationParticipants({conversationId:c.id,actorId:"bob",addUserIds:["carol"]}),ConversationAccessError);
  await assert.rejects(conversations.updateConversationParticipants({conversationId:c.id,actorId:"alice",removeUserIds:["alice"]}),ConversationInputError);
  assert.deepEqual(await conversations.updateConversationParticipants({conversationId:c.id,actorId:"alice",addUserIds:["carol"],removeUserIds:["bob"]}),["alice","carol"]);
  await assert.rejects(conversations.deleteConversation({conversationId:c.id,actorId:"bob"}),ConversationAccessError);
  assert.equal(await conversations.deleteConversation({conversationId:c.id,actorId:"alice"}),true);
 } finally {db.close();}
});

test("SQLite outbox claims leases, increments attempts, and supports delivery/retry",async()=>{
 const {db,conversations,outbox}=await fixture();
 try {
  const c=await conversations.createConversation({actorId:"alice",participantIds:["bob"]});
  const message=await conversations.persistMessage({conversationId:c.id,senderId:"alice",body:"event",idempotencyKey:"outbox-1"});
  const events=await outbox.claimOutboxEvents({limit:10,leaseSeconds:60});
  assert.equal(events.length,1); assert.equal(events[0].event_key,"message:"+message.id); assert.equal(events[0].attempts,1);
  assert.deepEqual(events[0].payload,{messageId:message.id,conversationId:c.id,senderId:"alice"});
  assert.equal((await outbox.claimOutboxEvents()).length,0);
  assert.equal(await outbox.markOutboxDelivered({eventId:events[0].id}),true);
  assert.equal(await outbox.markOutboxDelivered({eventId:events[0].id}),false);
  const retry=await conversations.persistMessage({conversationId:c.id,senderId:"bob",body:"retry",idempotencyKey:"outbox-2"});
  const claimed=await outbox.claimOutboxEvents();
  assert.equal(claimed.length,1);
  assert.equal(await outbox.rescheduleOutboxEvent({eventId:claimed[0].id,delaySeconds:60}),true);
  assert.equal((await outbox.claimOutboxEvents()).length,0);
  assert.ok(retry.id);
 } finally {db.close();}
});
