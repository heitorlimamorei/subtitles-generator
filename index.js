// index.js

import 'dotenv/config';           // Carrega variáveis do .env
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

import ffmpegPath from 'ffmpeg-static';  // FFmpeg estático (embutido)
import fluentFfmpeg from 'fluent-ffmpeg';

import PromptSync from 'prompt-sync';    // Para perguntar ao usuário no console
const prompt = PromptSync();

import { Configuration, OpenAIApi } from 'openai';

// -------------------------------------------------------
// Substitutos do __dirname / __filename em ESM
// -------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------
// Configuração do FFmpeg (usando binário estático)
// -------------------------------------------------------
fluentFfmpeg.setFfmpegPath(ffmpegPath);

// -------------------------------------------------------
// Configuração da OpenAI
// -------------------------------------------------------
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// -------------------------------------------------------
// Perguntas iniciais ao usuário via prompt
// -------------------------------------------------------
const fromLang = prompt('Qual é o idioma original do(s) vídeo(s)? (Ex: de, en, pt, es): ');
const toLang = prompt('Para qual idioma deseja traduzir/legendar? (Ex: pt, en, es): ');

// -------------------------------------------------------
// Função principal
// -------------------------------------------------------
async function main() {
  try {
    // Definições de pastas
    const VIDEOS_DIR = path.join(__dirname, 'videos');
    const SUBTITLES_DIR = path.join(__dirname, 'subtitles');
    const OUTPUT_DIR = path.join(__dirname, 'with-subtitles');

    // Garante que as pastas de saída existam
    await fs.ensureDir(SUBTITLES_DIR);
    await fs.ensureDir(OUTPUT_DIR);

    // Lê arquivos de vídeo
    const files = await fs.readdir(VIDEOS_DIR);
    const validExtensions = new Set(['.mp4', '.mov', '.avi', '.mkv']);

    // Filtra apenas arquivos de vídeo
    const videoFiles = files.filter((f) =>
      validExtensions.has(path.extname(f).toLowerCase())
    );

    if (videoFiles.length === 0) {
      console.log('Nenhum arquivo de vídeo encontrado em ./videos');
      return;
    }

    // Para cada vídeo encontrado...
    for (const videoFile of videoFiles) {
      console.log(`\n[PROCESSANDO]: ${videoFile}`);
      const videoPath = path.join(VIDEOS_DIR, videoFile);
      const baseName = path.basename(videoFile, path.extname(videoFile));

      // 1) Extrair áudio
      const audioPath = await extractAudio(videoPath);

      // 2) Transcrever (verbose_json) para obter timestamps
      console.log('  - Transcrevendo com Whisper (verbose_json)...');
      const transcriptionResp = await openai.createTranscription(
        fs.createReadStream(audioPath),
        'whisper-1',    // Modelo
        undefined,      // prompt (opcional)
        'verbose_json', // formato detalhado
        1.0,            // temperatura
        fromLang        // idioma original do áudio
      );
      const segments = transcriptionResp.data.segments; 
      // => [ { start, end, text }, ...]

      // 3) Traduzir cada segmento via GPT (Promise.all para rodar em paralelo)
      console.log('  - Traduzindo cada segmento para o idioma destino via GPT...');
      const translatedSegments = await translateSegmentsWithGPT(
        segments,
        fromLang,
        toLang,
        'gpt-4' // ou 'gpt-3.5-turbo'
      );

      // 4) Gerar .srt sincronizado
      const srtContent = buildSrtFromSegments(translatedSegments);

      // Nome do SRT => "nomeOriginal with subtitles.srt"
      const srtFilename = `${baseName} with subtitles.srt`;
      const srtPath = path.join(SUBTITLES_DIR, srtFilename);

      await fs.writeFile(srtPath, srtContent, 'utf8');
      console.log('  - Arquivo SRT criado em:', srtPath);

      // 5) Queimar legenda no vídeo
      // Nome de saída => "nomeOriginal with subtitles.mp4"
      const outputFilename = `${baseName} with subtitles.mp4`;
      const outputVideoPath = path.join(OUTPUT_DIR, outputFilename);

      console.log('  - Embutindo legenda no vídeo...');
      await burnSubtitles(videoPath, srtPath, outputVideoPath);

      console.log(`  ✔ Vídeo final legendado: ${outputVideoPath}`);

      // 6) Remove o arquivo de áudio temporário
      await fs.remove(audioPath);
      // (Opcional) também pode remover o SRT original daqui, se quiser manter só o final
      // await fs.remove(srtPath);
    }

    console.log('\nProcesso concluído com sucesso!');
  } catch (err) {
    console.error('Erro geral:', err);
  }
}

// Executa a função principal
main();

// -------------------------------------------------------
//  FUNÇÕES AUXILIARES
// -------------------------------------------------------

/**
 * Extrai o áudio do vídeo (em MP3)
 */
function extractAudio(videoPath) {
  return new Promise((resolve, reject) => {
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const audioPath = path.join(__dirname, `${baseName}.mp3`);

    fluentFfmpeg(videoPath)
      .output(audioPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .on('end', () => resolve(audioPath))
      .on('error', reject)
      .run();
  });
}

/**
 * Traduz cada segmento via GPT em paralelo.
 * @param {Array} segments - Array com { start, end, text }
 * @param {string} fromLang - Idioma de origem
 * @param {string} toLang   - Idioma de destino
 * @param {string} model    - 'gpt-4', 'gpt-3.5-turbo', etc.
 * @returns {Array} Novo array de segments com texto traduzido
 */
async function translateSegmentsWithGPT(segments, fromLang, toLang, model = 'gpt-4') {
  const promises = segments.map((seg) => {
    const originalText = seg.text;
    return openai.createChatCompletion({
      model,
      messages: [
        {
          role: 'system',
          content: `Você é um tradutor que converte textos do idioma ${fromLang} para o ${toLang}. 
Responda somente com a tradução, sem comentários adicionais.`
        },
        {
          role: 'user',
          content: originalText
        }
      ]
    });
  });

  // Execução em paralelo
  const responses = await Promise.all(promises);

  // Mapeia cada resposta para o texto traduzido
  return segments.map((seg, i) => {
    const translatedText = responses[i].data.choices[0].message?.content?.trim() || '';
    return {
      ...seg,
      text: translatedText
    };
  });
}

/**
 * Converte segments em formato SRT sincronizado
 */
function buildSrtFromSegments(segments) {
  let srt = '';
  segments.forEach((seg, i) => {
    const startTime = secondsToSrtTime(seg.start);
    const endTime = secondsToSrtTime(seg.end);

    srt += `${i + 1}\n`;
    srt += `${startTime} --> ${endTime}\n`;
    srt += `${seg.text}\n\n`;
  });
  return srt;
}

/**
 * Converte segundos fracionários em "HH:MM:SS,mmm" (padrão SRT)
 */
function secondsToSrtTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(milliseconds).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Queima (embute) a legenda no vídeo, centralizada, acima da borda
 */
function burnSubtitles(videoPath, srtPath, outputPath) {
  return new Promise((resolve, reject) => {
    fluentFfmpeg(videoPath)
      .videoCodec('libx264')
      .outputOptions([
        '-vf',
        `subtitles='${srtPath}:force_style=Alignment=2,MarginV=40'`
      ])
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}