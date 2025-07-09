const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('toggle-btn');
toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    sidebar.classList.toggle('active');
});

const chatSidebar = document.getElementById('chatSidebar');
const chatToggle = document.getElementById('chatToggle');
const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('send-button');
const floatingIcons = document.querySelector('.floating-icons');
const statusMessage = document.querySelector('.status-message');

chatToggle.addEventListener('click', toggleChat);
function toggleChat() {
    chatSidebar.classList.toggle('active');
    floatingIcons.classList.toggle('hide');
}

const BACKEND_URL = 'https://shareunixia-api.onrender.com';
let isProcessing = false;
const sessionId = 'session_' + Date.now() + Math.random().toString(36).substring(2, 15);

/**
 * Añade un mensaje al contenedor del chat.
 */
function addMessage(text, sender) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'message-bubble';
    bubbleDiv.textContent = text;
    messageDiv.appendChild(bubbleDiv);
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return bubbleDiv;
}

/**
 * Efecto de escritura tipo máquina de escribir.
 */
async function typeText(element, newText, delay = 15) {
    for (let i = 0; i < newText.length; i++) {
        element.textContent += newText[i];
        chatMessages.scrollTop = chatMessages.scrollHeight;
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

async function sendMessage() {
    if (isProcessing) return;
    const input = userInput.value.trim();
    if (!input) return;

    isProcessing = true;
    userInput.disabled = true;
    if (sendButton) sendButton.disabled = true;

    addMessage(input, 'user');
    userInput.value = '';

    if (statusMessage) statusMessage.textContent = 'Pensando... 🧠';

    // 👉 Mostrar mensaje temporal de espera (como typing...)
    const botBubble = addMessage('"Cargando... ⏳ Por favor, espera un momento."', 'bot');
    let accumulatedResponse = '';

    try {
        const res = await fetch(`${BACKEND_URL}/api/together-ai`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: input, sessionId: sessionId, stream: true }),
        });

        if (!res.ok) {
            const errorText = await res.text();
            let errorData = {};
            try {
                errorData = JSON.parse(errorText);
            } catch (e) {
                errorData = { error: errorText };
            }
            throw new Error(`HTTP error! status: ${res.status}. Detalles: ${errorData.error || res.statusText}`);
        }

        if (statusMessage) statusMessage.textContent = '';

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let firstChunkArrived = false;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonStr = line.substring(6);
                    if (jsonStr === '[DONE]') {
                        reader.releaseLock();
                        return;
                    }
                    try {
                        const data = JSON.parse(jsonStr);
                        if (data.response) {
                            if (!firstChunkArrived) {
                                // Limpiar mensaje temporal cuando llega el primer token real
                                botBubble.textContent = '';
                                firstChunkArrived = true;
                            }
                            accumulatedResponse += data.response;
                            await typeText(botBubble, data.response);
                        } else if (data.error) {
                            throw new Error(data.error);
                        }
                    } catch (e) {
                        console.error("Error al parsear chunk:", e, line);
                        if (!firstChunkArrived) botBubble.textContent = '';
                        accumulatedResponse += line;
                        await typeText(botBubble, line);
                    }
                } else {
                    if (!firstChunkArrived) botBubble.textContent = '';
                    accumulatedResponse += line;
                    await typeText(botBubble, line);
                }
            }
        }

    } catch (err) {
        if (statusMessage) statusMessage.textContent = '';
        const errorMsg = err.message.includes('429')
            ? '⚠️ Espera que termine la respuesta anterior.'
            : `❌ Error: ${err.message}`;
        if (accumulatedResponse) {
            botBubble.textContent = accumulatedResponse + `\n\n${errorMsg}`;
        } else {
            botBubble.textContent = errorMsg;
        }
        console.error('Error en sendMessage:', err);
    } finally {
        isProcessing = false;
        userInput.disabled = false;
        if (sendButton) sendButton.disabled = false;
        userInput.focus();
        if (statusMessage) statusMessage.textContent = '';
    }
}

// Event Listeners
if (sendButton) {
    sendButton.addEventListener('click', sendMessage);
}
userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});
