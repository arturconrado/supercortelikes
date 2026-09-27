# Fixtures de mídia — proveniência e checksums

## `low-resolution-portrait-90s.mov` — CEN-006

- **Origem:** derivado de "Dwight D. Eisenhower - Farewell Address (Military-Industrial Complex speech), 1961", https://archive.org/details/DwightD.Eisenhower-FarewellAddressmilitary-industrialComplexSpeech (derivativo `EisenhowersFarewellAddress1.mp4`, 640x360, 944,92 s).
- **Licença:** domínio público — discurso oficial do presidente dos EUA, obra do governo federal (17 U.S.C. § 105), hospedado na coleção `opensource_movies` do Internet Archive.
- **Transformação:** recorte de 90 s (120s–210s, falante contínuo, sem cartela de abertura) e `crop=360:202:140:79` (região central, foco no rosto/torso).
- **⚠️ Correção 2026-09-27 — rotação ausente:** a versão anterior deste manifesto afirmava que o metadado `rotate=90` havia sido aplicado. **Não foi.** `ffprobe -show_entries stream_side_data` não retorna matriz de rotação nem tag `rotate`; o arquivo é exibido em paisagem 360x202. Portanto esta fixture **não** exercita o critério "vídeo vertical / rotação EXIF não gera vídeo deitado" do CEN-006 — cobre apenas baixa resolução + um falante. Além disso, é filmagem de arquivo em preto e branco (1961), não representativa de uploads reais. Substituir por gravação própria de celular na vertical (ver "Fixtures realistas pendentes" abaixo).
- **Conteúdo:** um único falante (rosto centralizado, fala contínua), áudio real (voz).
- **Duração:** 89,97 s (vídeo), 90,00 s (áudio).
- **Resolução armazenada:** 360x202 (paisagem, sem rotação), H.264 + AAC, contêiner `.mov`.
- **Tamanho:** 1.983.742 bytes (≈1,9 MB).
- **SHA-256:** `3fa93b8f1e4aa3e093ce765f761108414fed63e426235c18ca9f672bbd52f434`

## `multiple-people-reframe.mp4` — CEN-012

- **Origem:** derivado de "Duck and Cover" (1951), https://archive.org/details/0771_Duck_and_Cover_12_33_20_12 (coleção Prelinger, derivativo original 640x480, 555,5 s).
- **Licença:** domínio público — filme de defesa civil produzido pelo governo federal dos EUA, coleção `prelinger` do Internet Archive.
- **Transformação:** recorte de 90 s (260s–350s), reencodado em H.264/AAC sem alteração de resolução/proporção. O trecho cobre uma cena com dois adultos ao ar livre (falando, entrando/saindo de quadro) seguida de uma cena com um grupo de seis crianças em ambiente interno — múltiplas pessoas, composição e enquadramento variando ao longo do clipe.
- **Conteúdo:** múltiplas pessoas (mínimo 2 na primeira metade, 6 na segunda), áudio real (narração/diálogo).
- **Duração:** 89,99 s (vídeo), 90,00 s (áudio).
- **Resolução:** 640x480, H.264 + AAC, contêiner `.mp4`.
- **Tamanho:** 14.702.820 bytes (≈14 MB).
- **SHA-256:** `01162f7130ae040bda8cef54dc5689e6aacbdab101cdbacfc5d9b72d48ac92ec`

- **⚠️ Limitação 2026-09-27:** inspeção de quadros a cada 15 s mostra pessoas majoritariamente de costas, cenas sem pessoas (rua, casas, corredor) e crianças escondendo o rosto (é o exercício "duck and cover"). Quase não há dois rostos frontais simultâneos nem troca de falante em câmera. Serve como teste de robustez (pessoas entrando/saindo, sem crash), **não** como validação de reframe multi-falante. Preto e branco, 4:3, 1951.

## Fixtures realistas pendentes (necessárias para aprovar CEN-006 / CEN-012)

Gravação própria, com consentimento das pessoas filmadas, representando uploads reais do produto:

| Arquivo sugerido | Cenário | Como gravar | O que valida |
| --- | --- | --- | --- |
| `real-phone-portrait-selfie-90s.mov` | CEN-006 | Celular na vertical, 1 pessoa falando ~90 s; exportar em ≤480p mantendo o metadado de rotação do aparelho | Rotação real, rosto sempre enquadrado, baixa resolução |
| `real-two-speaker-podcast-3m.mp4` | CEN-012 | 2 pessoas lado a lado, câmera 16:9 fixa, fala alternada (~10 s por turno) por 2–3 min | Foco segue quem fala, troca de sujeito |
| `real-three-people-entry-exit-2m.mp4` | CEN-012 | 3 pessoas, alguém entra e sai do quadro durante a fala | Nenhum rosto cortado, trilhas visuais não trocadas entre pessoas |

Antes de usar cada arquivo: conferir rotação/resolução com `ffprobe`, gerar contact sheet (`ffmpeg -vf "fps=1/10,scale=-1:200,tile=6x2"`) e confirmar visualmente que as condições do cenário estão presentes; registrar SHA-256 aqui.

## Fixtures pré-existentes

- `pet-cat-bench-75s.mp4` e `funny-painted-car-27s.mp4` — usados em sessões anteriores de smoke/E2E; sem manifesto de origem registrado até esta atualização.
