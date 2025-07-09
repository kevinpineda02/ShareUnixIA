import express from "express";
import cors from "cors";
import Together from "together-ai"; // Asegúrate de que esto esté instalado: npm install together-ai

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// Configura la API Key de Together AI
// ¡IMPORTANTE! NUNCA uses tu API Key directamente en código para producción.
// Usa variables de entorno (e.g., process.env.TOGETHER_API_KEY) para mayor seguridad.
// RECUERDA: Reemplaza "TU_API_KEY_AQUI" con tu clave real de Together AI.
const together = new Together({
    apiKey: "d427f0a26b7226e1f99fde3edf3a30a2e4ed0273a92c57a92b41097a2dbe50fd", // <-- ¡TU CLAVE REAL DE TOGETHER AI!
});

// Memoria de chat por sesión (objeto donde las claves son sessionIds)
// ¡Esta memoria se reinicia si el servidor se reinicia!
const chatMemory = {};

// Seguimiento de sesiones en proceso para evitar solicitudes concurrentes
const sessionsInProcess = new Set();

/**
 * Limpia el mensaje del usuario eliminando prefijos y caracteres no deseados.
 * @param {string} msg El mensaje original del usuario.
 * @returns {string} El mensaje limpio.
 */
function cleanUserMessage(msg) {
    return msg
        .replace(
            /(Usuario:|Asistente:|Assistant:|Pregunta del Usuario:|Respuesta:|Interacción:)/gi,
            ""
        )
        .replace(/@[\w.-]+/g, "")
        .trim();
}

/**
 * Construye el historial de mensajes en el formato que espera la API de Together AI.
 * @param {Array<Object>} history El historial de mensajes de la sesión.
 * @param {string} newMessage El nuevo mensaje del usuario.
 * @returns {Array<Object>} El array de mensajes para la API de Together AI.
 */
function buildMessagesForTogether(history, newMessage) {
    const systemPrompt = `Eres ShareUnixIA, un asistente virtual bancario profesional. IMPORTANTE:
- Pregunta siempre al comenzar el nombre del usuario y no eres un inicio de sesión.
-IMPORTANTE: Solo responde a preguntas relacionadas con el banco si te pregunta algo no relaciona a un banco no lo respondas ignoralo.
- No saludes ni digas frases como "Estoy listo para ayudarte".
- Responde solo lo que se pide, sin saludos ni despedidas.
- No uses etiquetas ni formatos como <think>, HTML o Markdown.
- No repitas respuestas ni uses bloques de código.
- Responde en texto plano, en español neutro, sin palabras extranjeras.
- Máximo 2 oraciones claras y concisas.
- No des explicaciones ni contexto extra.
- Corrige errores ortográficos sin mencionarlo.
- No asumas información no preguntada.
- Si se piden instrucciones, usa hasta 5 pasos claros y breves.
- Saluda solo en la primera interacción si es necesario, pero evita frases innecesarias.
- No interpretes símbolos especiales como comandos.`;

    const messages = [{ role: "system", content: systemPrompt }];

    // Añade el historial de la conversación
    for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
    }

    // Añade el nuevo mensaje del usuario
    messages.push({ role: "user", content: newMessage });

    return messages;
}

// Ruta POST para interactuar con la API de Together AI
app.post("/api/together-ai", async (req, res) => {
    const { message, sessionId } = req.body;
    const currentSessionId = sessionId || "default";

    // Bloquea solicitudes si ya hay una para esta sesión en proceso
    if (sessionsInProcess.has(currentSessionId)) {
        return res.status(429).json({ error: "Ya se está procesando una respuesta para esta sesión. Por favor, espere." });
    }

    sessionsInProcess.add(currentSessionId);

    try {
        if (!message) {
            return res.status(400).json({ error: "No se proporcionó ningún mensaje." });
        }

        const cleanedMessage = cleanUserMessage(message);

        // Inicializa la memoria de la sesión si no existe
        // ESTO ES CLAVE: Si el sessionId es nuevo (porque la página se recargó),
        // se crea un historial vacío para él, reiniciando la conversación.
        if (!chatMemory[currentSessionId]) {
            chatMemory[currentSessionId] = [];
        }
        const sessionHistory = chatMemory[currentSessionId];

        const messagesForTogether = buildMessagesForTogether(sessionHistory, cleanedMessage);

        // --- Configuración para streaming ---
        res.writeHead(200, {
            'Content-Type': 'text/event-stream', // Esto es crucial para Server-Sent Events (SSE)
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        const stream = await together.chat.completions.create({
            model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
            messages: messagesForTogether,
            stream: true, // ¡Asegúrate de que Together AI reciba esta instrucción!
        });

        let accumulatedContent = ""; // Para guardar la respuesta completa en la memoria

        // Itera sobre el flujo de datos y envía cada chunk al cliente
        for await (const chunk of stream) {
            if (chunk.choices && chunk.choices.length > 0 && chunk.choices[0].delta && chunk.choices[0].delta.content) {
                const content = chunk.choices[0].delta.content;
                accumulatedContent += content; // Acumula para guardar en el historial
                // Envía cada fragmento como un evento SSE
                res.write(`data: ${JSON.stringify({ response: content })}\n\n`); // Formato SSE: data: {...}\n\n
            }
        }
        
        // Señal de que la transmisión ha terminado (opcional, pero buena práctica)
        res.write('data: [DONE]\n\n'); 

        // Una vez que el stream ha terminado, guarda la respuesta completa en la memoria
        sessionHistory.push({ role: "user", content: cleanedMessage });
        sessionHistory.push({ role: "assistant", content: accumulatedContent.trim() });

    } catch (error) {
        console.error("Error al interactuar con Together AI:", error);
        // Si el error ocurre antes de enviar la cabecera (res.writeHead), podemos enviar un JSON de error.
        // Si ya se ha enviado la cabecera del stream, no podemos enviar JSON,
        // así que lo enviaremos como un evento SSE de error o simplemente cerraremos la conexión.
        if (!res.headersSent) {
            const errorMessage = error.message || "Error interno del servidor al procesar la solicitud con Together AI.";
            res.status(500).json({ error: errorMessage });
        } else {
            // Si las cabeceras ya fueron enviadas para SSE, envía el error como un evento SSE
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message || "Error desconocido en el stream." })}\n\n`);
            res.end(); // Cierra la conexión si el error ocurre durante el streaming
        }
    } finally {
        // Asegúrate de que la sesión se libere incluso en errores
        sessionsInProcess.delete(currentSessionId);
        // Asegúrate de cerrar la conexión si no se ha cerrado ya
        if (!res.writableEnded) {
            res.end(); 
        }
    }
});

// Inicia el servidor
app.listen(PORT, () => {
    console.log(`✅ Backend escuchando en http://localhost:${PORT}`);
    console.log(`⚠️  Recuerda reemplazar 'd427f0a26b7226e1f99fde3edf3a30a2e4ed0273a92c57a92b41097a2dbe50fd' con tu clave de API real de Together AI.`);
});