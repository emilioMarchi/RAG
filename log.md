> rag-studio@1.0.0 build
> tsc

src/services/chunkingService.ts:43:33 - error TS2339: Property 'default' does not exist on type 'typeof import("D:/Emi/apps/RAG/node_modules/pdf-parse/dist/pdf-parse/esm/index")'.

43     const data = await pdfParse.default(dataBuffer);
                                   ~~~~~~~


Found 1 error in src/services/chunkingService.ts:43

PS D:\Emi\apps\RAG> npm run build

> rag-studio@1.0.0 build
> tsc

src/services/chunkingService.ts:43:38 - error TS2339: Property 'default' does not exist on type 'typeof import("D:/Emi/apps/RAG/node_modules/pdf-parse/dist/pdf-parse/esm/index")'.

43     const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (buf: Buffer) => Promise<{ text: string }>;
                                        ~~~~~~~


Found 1 error in src/services/chunkingService.ts:43

PS D:\Emi\apps\RAG>