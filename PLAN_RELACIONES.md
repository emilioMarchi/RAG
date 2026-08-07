Windows PowerShell
Copyright (C) Microsoft Corporation. Todos los derechos reservados.

Prueba la nueva tecnología PowerShell multiplataforma https://aka.ms/pscore6

PS C:\WINDOWS\system32> cd a
cd : No se encuentra la ruta de acceso 'C:\WINDOWS\system32\a' porque no existe.
En línea: 1 Carácter: 1
+ cd a
+ ~~~~
    + CategoryInfo          : ObjectNotFound: (C:\WINDOWS\system32\a:String) [Set-Location], ItemNotFoundException
    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.SetLocationCommand

PS C:\WINDOWS\system32> cd D:\Emi\apps\RAG
PS D:\Emi\apps\RAG> npm run dev

> rag-studio@1.0.0 dev
> tsx watch src/index.ts

◇ injected env (12) from .env // tip: ◈ secrets for agents [www.dotenvx.com]
RAG API running on http://localhost:3000
Health: http://localhost:3000/api/health
[EMBED DEBUG] dim=768 text.length=10663 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Documento Técnico de Referencia: AetherCore v4.5\nManual de Arquitectura, Políticas Operativas y Especificaciones de Evaluación RAG\
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.032162365,0.017246904,0.0050362963,-0.074690446,-0.0171457,0.022989426,0.018841619,0.0032010411,0.0022334657,0.016511543,-0.0333054,0.005170005,0.055615943,0.010600657,0.13474855,0.0047994903,-0.009545541,0.017061206,0.015044836,-0.021599498,0.022128286,-0.00414955,-0.0321
[EMBED DEBUG] dim=1536 text.length=522 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Este fragmento constituye la sección de cierre y las instrucciones de procesamiento de datos del documento técnico de referencia Aet
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.015349364,0.019274043,-0.010117164,-0.06776162,-0.004528966,0.021680767,0.026380956,-0.0047688847,-0.010548612,0.013760763,-0.016511403,-0.0036935564,0.04097886,0.0013683115,0.1318021,0.006355029,-0.0055617886,0.007076831,0.004236498,-0.003966295,0.010121742,-0.003664719,-
[EMBED DEBUG] dim=1536 text.length=2745 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Este fragmento constituye la sección introductoria y el índice general del documento técnico de referencia para la plataforma Aether
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.026543789,0.00929402,0.005760066,-0.0629502,-0.030276831,0.0154245505,0.009541091,0.00005255561,-0.011351917,0.024755223,-0.035851125,0.017218245,0.05193251,0.018949835,0.14936087,0.007780082,0.006535941,0.020406501,0.012725347,-0.011551745,0.019174006,-0.001912344,-0.0344
[enrich-chunk] Attempt 1/3 failed. Retrying in 2000ms...
[EMBED DEBUG] dim=1536 text.length=2644 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Este fragmento detalla las políticas de retención de datos, estándares de cifrado y procedimientos operativos de seguridad y manejo
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.013212121,0.028869547,-0.0027774763,-0.057369173,-0.0074216984,0.021386588,0.020495333,-0.006181028,-0.0027373985,0.0096464,-0.014408499,-0.012963432,0.047044598,0.0023160214,0.12860139,-0.000792608,-0.024762617,0.010161,0.013072708,-0.020871175,0.02912576,-0.0126035,-0.02
[enrich-chunk] Attempt 2/3 failed. Retrying in 4000ms...
Upload error: SyntaxError: Bad escaped character in JSON at position 1867 (line 2 column 1866)
    at JSON.parse (<anonymous>)
    at LLMService.parseJSON (D:\Emi\apps\RAG\src\services\llmService.ts:33:19)
    at withRetry.maxRetries (D:\Emi\apps\RAG\src\services\llmService.ts:100:21)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async withRetry (D:\Emi\apps\RAG\src\utils\retry.ts:9:14)
    at async <anonymous> (D:\Emi\apps\RAG\src\services\ingestionPipeline.ts:51:28)
    at async worker (D:\Emi\apps\RAG\src\utils\concurrency.ts:12:20)
    at async Promise.all (index 1)
    at async mapConcurrent (D:\Emi\apps\RAG\src\utils\concurrency.ts:17:3)
    at async IngestionPipeline.processAndStoreDocument (D:\Emi\apps\RAG\src\services\ingestionPipeline.ts:48:34)
[EMBED DEBUG] dim=1536 text.length=2670 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Este fragmento presenta los datos de validación y el glosario técnico necesarios para evaluar el rendimiento del sistema RAG en el e
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.024317443,0.021829383,0.01111333,-0.06797406,-0.020032719,0.018582843,0.026814574,-0.006797066,-0.00048541668,0.0168942,-0.03327158,0.010172832,0.040520456,0.008457625,0.13570622,0.012291926,-0.0060758363,0.0405075,0.012287169,-0.009682956,0.02286708,-0.007973131,-0.030582