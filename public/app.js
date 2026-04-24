const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const chatMessages = document.getElementById("chatMessages");
const submitButton = chatForm.querySelector("button");
const sessionId = `session_${Date.now()}`;

let typingIndicator = null;
let activeOptionGroups = [];

addMessage(
  "bot",
  "Hola, soy Asistente Facu. Puedo ayudarte con recepciones, cobros y pagos."
);

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;
  await sendMessage(message);
});

async function sendMessage(message) {
  clearOptionGroups();
  addMessage("user", message);
  messageInput.value = "";
  setLoading(true);
  showTyping();

  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId })
    });
    const data = await response.json();
    if (!response.ok) {
      addMessage("bot", `Error: ${data.error || "No se pudo procesar el mensaje."}`);
      return;
    }
    const botMessage = addMessage("bot", data.reply || "Listo.");
    if (Array.isArray(data.options) && data.options.length) {
      renderOptions(botMessage, data.options);
    }
  } catch (error) {
    addMessage("bot", `Error de red: ${error.message}`);
  } finally {
    hideTyping();
    setLoading(false);
    messageInput.focus();
  }
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  scrollToBottom();
  return div;
}

function renderOptions(anchorMessage, options) {
  const group = document.createElement("div");
  group.className = "options-group";
  options.forEach((label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.textContent = label;
    btn.addEventListener("click", async () => {
      clearOptionGroups();
      await sendMessage(label);
    });
    group.appendChild(btn);
  });
  chatMessages.insertBefore(group, anchorMessage.nextSibling);
  activeOptionGroups.push(group);
  scrollToBottom();
}

function showTyping() {
  if (typingIndicator) return;
  typingIndicator = document.createElement("div");
  typingIndicator.className = "message bot typing";
  typingIndicator.innerHTML = `<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>`;
  chatMessages.appendChild(typingIndicator);
  scrollToBottom();
}

function hideTyping() {
  if (!typingIndicator) return;
  typingIndicator.remove();
  typingIndicator = null;
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Procesando..." : "Enviar";
}

function clearOptionGroups() {
  activeOptionGroups.forEach((group) => group.remove());
  activeOptionGroups = [];
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
