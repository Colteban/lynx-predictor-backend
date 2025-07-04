// --- ÁMBITO GLOBAL: MÍNIMO INDISPENSABLE ---
// Solo importamos los tipos, que se borran en la compilación y no afectan el arranque.
import * as functions from "firebase-functions/v1";
import type {QueryDocumentSnapshot} from "firebase-functions/v1/firestore";

// Las constantes y definiciones de funciones están bien aquí.
const CONFIG = {
  BUCKET_NAME: "lynx-predictor.firebasestorage.app", // REEMPLAZA ESTO
  STORAGE_FILE_PATH: "training-data/roulette_contextual_vectors.csv",
  FUNCTION_REGION: "southamerica-east1",
};

const WHEEL_LAYOUTS = {
  europea: [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26],
  americana: [0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, -1, 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2],
};

interface SpinDocument {
  rouletteType: "europea" | "americana";
  actualOutcome: number;
  history: number[];
}

function getWheelPosition(num: number, wheel: number[]): number {
  return wheel.indexOf(num);
}
// ... (resto de funciones de cálculo que no cambian) ...
function calculateRecency(num: number, history: number[]): number {
  const lastIndex = history.lastIndexOf(num);
  if (lastIndex === -1 || history.length === 0) return 0;
  return (lastIndex + 1) / history.length;
}
function calculateFrequency(num: number, history: number[]): number {
  if (history.length === 0) return 0;
  const count = history.filter((n) => n === num).length;
  return count / history.length;
}
function calculateMarkovStrength(num: number, history: number[]): number {
  if (history.length < 1) return 0;
  const lastNumber = history[history.length - 1];
  let transitionCount = 0;
  let totalOccurrencesOfLast = 0;
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i] === lastNumber) {
      totalOccurrencesOfLast++;
      if (history[i + 1] === num) transitionCount++;
    }
  }
  return totalOccurrencesOfLast === 0 ? 0 : transitionCount / totalOccurrencesOfLast;
}
function calculateMagneticZoneScore(num: number, history: number[], wheel: number[], neighbors: number): number {
  const uniqueHistory = [...new Set(history.slice(-8))];
  if (uniqueHistory.length === 0) return 0;
  const wheelSize = wheel.length;
  const numPos = wheel.indexOf(num);
  let score = 0;
  for (const historyNum of uniqueHistory) {
    const historyNumPos = wheel.indexOf(historyNum);
    const distance = Math.min(Math.abs(numPos - historyNumPos), wheelSize - Math.abs(numPos - historyNumPos));
    if (distance <= neighbors) {
      score += (neighbors - distance + 1);
    }
  }
  const maxPossibleScore = uniqueHistory.length * (neighbors + 1);
  return maxPossibleScore === 0 ? 0 : score / maxPossibleScore;
}


export const generateContextualVector = functions
  .region(CONFIG.FUNCTION_REGION)
  .firestore.document("roulette-history/{spinId}")
  .onCreate(async (snapshot: QueryDocumentSnapshot) => {
    // --- INICIALIZACIÓN ULTRA-PEREZOSA ---
    // ¡Importamos las librerías aquí dentro!
    const admin = require("firebase-admin");
    const {Storage} = require("@google-cloud/storage");

    if (admin.apps.length === 0) {
      admin.initializeApp();
    }
    const storage = new Storage();
    // ------------------------------------

    const spinData = snapshot.data() as SpinDocument;
    functions.logger.info("Procesando nuevo documento:", spinData);

    if (!spinData || !spinData.rouletteType || spinData.actualOutcome === undefined || !spinData.history) {
      functions.logger.error("Documento inválido o campos faltantes.");
      return;
    }

    try {
      const {actualOutcome, history, rouletteType} = spinData;
      const wheel = WHEEL_LAYOUTS[rouletteType];
      const vector = [
        getWheelPosition(actualOutcome, wheel),
        calculateRecency(actualOutcome, history),
        calculateFrequency(actualOutcome, history),
        calculateMarkovStrength(actualOutcome, history),
        calculateMagneticZoneScore(actualOutcome, history, wheel, 3),
      ];

      const csvRow = vector.join(",") + "\n";
      const bucket = storage.bucket(CONFIG.BUCKET_NAME);
      const file = bucket.file(CONFIG.STORAGE_FILE_PATH);
      const [exists] = await file.exists();

      if (!exists) {
        const header = "wheelPosition,recency,frequency,markovStrength,magneticZoneScore\n";
        await file.save(header + csvRow, {resumable: false, contentType: "text/csv"});
      } else {
        const [existingContent] = await file.download();
        const newContent = existingContent.toString("utf-8") + csvRow;
        await file.save(newContent, {resumable: false, contentType: "text/csv"});
      }

      functions.logger.info("Proceso completado exitosamente.");
    } catch (error) {
      functions.logger.error("Error catastrófico durante la generación del vector:", error);
    }
  });
