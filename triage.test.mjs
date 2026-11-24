import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./server.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

async function listen(app) {
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

async function post(base, body) {
  const reply = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

let app, base;
before(async () => {
  app = createApp();
  base = await listen(app);
});
after(() => app.close());

test("пустой, отсутствующий, нестроковый ввод и битый JSON → 400 invalid_input", async () => {
  const cases = [
    { text: "" }, { text: "   \n" }, {}, { text: 42 }, { text: null }, { text: ["a"] },
    null, [], '{"text": "oops', "not json", "",
  ];
  for (const input of cases) {
    const { status, body } = await post(base, input);
    assert.equal(status, 400, JSON.stringify(input));
    assert.deepEqual(body, { status: "invalid_input" });
  }
});

test("корректный ответ модели → ready с темой и черновиком", async () => {
  const draft = "Спасибо за обращение. Уточним детали заявки.";
  const expected = [
    ["Когда будет доставка?", "delivery"],
    ["Какая стоимость товара?", "pricing"],
    ["Здравствуйте", "other"],
  ];
  for (const [text, topic] of expected) {
    const { status, body } = await post(base, { text });
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "ready", topic, draft });
  }
});

test("сбои имитатора → 200 manual_review без темы и черновика", async () => {
  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    const { status, body } = await post(base, { text: `Вопрос про доставку ${marker}` });
    assert.equal(status, 200, marker);
    assert.deepEqual(body, MANUAL_REVIEW, marker);
  }
});

test("таймаут модели: ответ приходит около 300 мс, а не через 1,2 с", async () => {
  const started = performance.now();
  const { status, body } = await post(base, { text: "Заявка [timeout]" });
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(body, MANUAL_REVIEW);
  assert.ok(elapsed >= 250 && elapsed < 900, `elapsed=${Math.round(elapsed)}ms`);
});

test("неподходящие ответы модели и зависший провайдер → manual_review", async () => {
  const replies = [
    undefined, null, 42, "null", "[]", '"text"', "{}",
    '{"topic":"delivery"}',
    '{"topic":"delivery","draft":5}',
    '{"topic":"delivery","draft":""}',
    '{"topic":"Delivery","draft":"ok"}',
    '{"topic":{},"draft":"ok"}',
  ];
  for (const reply of replies) {
    const custom = createApp({ classify: async () => reply });
    const url = await listen(custom);
    try {
      const { status, body } = await post(url, { text: "Привет" });
      assert.equal(status, 200, String(reply));
      assert.deepEqual(body, MANUAL_REVIEW, String(reply));
    } finally {
      custom.close();
    }
  }

  // провайдер, который игнорирует сигнал отмены и не отвечает вообще
  const hanging = createApp({ classify: () => new Promise(() => {}) });
  const url = await listen(hanging);
  try {
    const started = performance.now();
    const { status, body } = await post(url, { text: "Привет" });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
    assert.ok(performance.now() - started < 900);
  } finally {
    hanging.closeAllConnections();
    hanging.close();
  }
});

test("ответ модели с лишними полями не попадает в ответ API", async () => {
  const noisy = createApp({
    classify: async () => JSON.stringify({ topic: "other", draft: "  Текст  ", secret: "x" }),
  });
  const url = await listen(noisy);
  try {
    const { body } = await post(url, { text: "Привет" });
    assert.deepEqual(body, { status: "ready", topic: "other", draft: "Текст" });
  } finally {
    noisy.close();
  }
});
