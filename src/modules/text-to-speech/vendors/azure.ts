import { createHash } from "node:crypto";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { TextToSpeechProvider } from "../base";
import type { AzureTextToSpeechOptions, TextToSpeechInput } from "../types";

/** Azure synthesis serializes requests and streams each complete 20 ms PCM frame. */
export class AzureTextToSpeech extends TextToSpeechProvider {
  private readonly speechConfig: sdk.SpeechConfig;
  private readonly speed: number;
  private ttsPromise: Promise<void> = Promise.resolve();
  private static readonly FRAME_SIZE = 320;

  constructor(options: AzureTextToSpeechOptions) {
    super(options.uuid);

    const apiKey = options.apiKey || process.env.AZURE_SPEECH_KEY;
    const region = options.region || process.env.AZURE_SPEECH_REGION;

    if (!apiKey || !region) {
      throw new Error("Azure TTS requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION");
    }

    this.speechConfig = sdk.SpeechConfig.fromSubscription(apiKey, region);
    this.speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw8Khz16BitMonoPcm;
    this.speechConfig.speechSynthesisVoiceName = options.speechSynthesisVoiceName;
    this.speed = options.speed || 1;
  }

  async connect(): Promise<void> {}

  sendText(input: TextToSpeechInput): Promise<void> {
    this.ttsPromise = this.ttsPromise
      .catch(() => {})
      .then(() => this.speakTextAsync(input));

    return this.ttsPromise;
  }

  /** Render the legacy SSML and stream each complete Azure PCM chunk. */
  private speakTextAsync(input: TextToSpeechInput): Promise<void> {
    const hash = createHash("md5").update(`${this.speechConfig.speechSynthesisVoiceName};${input.text}`).digest("hex");
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(`/var/spool/asterisk/monitor/${hash}.wav`);
    const synthesizer = new sdk.SpeechSynthesizer(this.speechConfig, audioConfig);

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">
                      <voice xml:lang='fr-FR' xml:gender='Female' name='${this.speechConfig.speechSynthesisVoiceName}'>
                        <mstts:express-as style="assistant" styledegree="2">
                              <prosody rate="${this.speed}">
                                ${input.text}
                              </prosody>
                        </mstts:express-as>
                      </voice>
                    </speak>`;

    return new Promise<void>((resolve, reject) => {
      synthesizer.synthesizing = (_sender, event) => {
        try {
          let chunk = Buffer.from(event.result.audioData);

          while (chunk.length >= AzureTextToSpeech.FRAME_SIZE) {
            this.emitAudioFrame(chunk.subarray(0, AzureTextToSpeech.FRAME_SIZE));
            chunk = chunk.subarray(AzureTextToSpeech.FRAME_SIZE);
          }
        } catch (error) {
          console.error(this.uuid, "Azure TTS audio processing failed", error);
        }
      };

      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          synthesizer.close();

          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve();
          } else {
            reject(new Error(`Speech synthesis canceled: ${result.errorDetails}`));
          }
        },
        (error) => {
          synthesizer.close();
          reject(error);
        }
      );
    });
  }

  async disconnect(): Promise<void> {}
}
