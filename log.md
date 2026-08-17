 rag-studio@1.0.0 dev
> tsx watch src/index.ts

◇ injected env (13) from .env // tip: ⌘ enable debugging { debug: true }
RAG API running on http://localhost:3000
Health: http://localhost:3000/api/health
[EMBED DEBUG] dim=768 text.length=3241 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"PROTECCION DE LOS DATOS PERSONALES\nLey 25.326\nDisposiciones Generales. Principios generales relativos a la protección de\ndatos. D
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.032327186,0.0222599,0.030921951,-0.053400956,0.005450473,0.048430838,0.018366998,0.02222017,0.029860798,-0.009676291,-0.003243394,0.028887948,-0.0060599684,-0.007261252,0.11254995,0.0056302296,0.0025996214,-0.003558937,0.009458773,-0.016270718,0.017461892,-0.023041217,-0.0
[Ingestion] Procesando 5 chunks con concurrencia=2, graphRAG=false
[EMBED DEBUG] dim=1536 text.length=619 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Documento: Proteccion de los datos personales-Ley 25.326-TEST.pdf\n\nPROTECCION DE LOS DATOS PERSONALESLey 25.326Disposiciones Gener
[EMBED DEBUG] dim=1536 text.length=919 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Documento: Proteccion de los datos personales-Ley 25.326-TEST.pdf\nContexto normativo: ARTICULO 1\n\ney: Ley de Protección de los Da
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.03075858,0.025098829,0.04063716,-0.059813347,0.01605883,0.033293206,0.0327153,0.012764979,0.031645015,-0.002967562,0.0020697538,0.015125902,0.009570964,0.0038406432,0.108657606,0.021706488,0.006370116,-0.009317233,0.009613692,-0.009202759,0.008204057,-0.01837584,-0.0039595
[EMBED DEBUG] dim=1536 text.length=758 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Documento: Proteccion de los datos personales-Ley 25.326-TEST.pdf\nContexto normativo: ARTICULO 2\n\ne podrán afectar la base de dat
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.034386743,0.023993455,0.029352603,-0.053879865,0.011121117,0.044557888,0.018136565,0.006804204,0.016730914,0.008380438,-0.009627974,0.015357125,0.0003980747,-0.0053912047,0.11175614,0.027651997,0.0051241,0.0005868317,0.006688832,-0.010480354,0.00018022934,-0.014476499,-0.0
[EMBED DEBUG] dim=1536 text.length=1358 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Documento: Proteccion de los datos personales-Ley 25.326-TEST.pdf\nContexto normativo: ARTICULO 2\n\nrganizado de datos personales q
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.010537084,0.009479369,0.043165933,-0.056510005,0.02166995,0.02181023,0.017959869,0.016719373,0.037668835,0.0057952735,-0.0145794,0.028802834,0.005475571,0.0024975094,0.10872905,0.0100438995,-0.00044193235,0.005305853,0.00014350784,-0.01694672,-0.0011472962,-0.0071761315,-0
[EMBED DEBUG] dim=1536 text.length=331 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"Documento: Proteccion de los datos personales-Ley 25.326-TEST.pdf\nContexto normativo: ARTICULO 2\n\nvos, registros o bancos de dato
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.013852117,0.012712937,0.03428195,-0.05308529,0.03260599,0.03215417,0.025634412,0.017294731,0.031225068,0.014088735,-0.020092657,0.027274318,-0.004388472,-0.005872132,0.11285301,0.006531061,-0.002951418,0.009093058,0.017565722,-0.0074591767,0.007465699,-0.009526475,-0.02680
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.009860665,0.0088133,0.021996299,-0.06685174,0.01872344,0.014206442,0.0377457,0.008003278,0.03656756,0.01126721,-0.0078115626,0.017957339,0.011468068,-0.013207405,0.10719816,0.0035490037,0.0011051629,0.023901924,-0.009929757,-0.007181363,0.010927992,-0.005948069,-0.01492093
[Ingestion] Progreso: 5/5 chunks procesados
[Ingestion] Enriquecimiento completo: 5/5 chunks listos para persistir.
[Ingestion] ✓ Documento "Proteccion de los datos personales-Ley 25.326-TEST.pdf" guardado: 5 chunks, 1 parent chunks, estrategia=legal
[AgentRouter] Decision para sessionId: session_ymka1kveui_1786627632958 -> intent: rag, query refinada: "puntos del artículo 2", motivo: El usuario solicita información específica sobre el contenido de un artículo, lo cual requiere búsqueda en los documentos.
[DECOMPOSE DEBUG] LLM raw response: {
  "sub_queries": [
    "puntos del artículo 2"
  ]
}
[EMBED DEBUG] dim=768 text.length=21 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"puntos del artículo 2"}]},"outputDimensionality":768}
[EMBED DEBUG] status=200 response={"embedding":{"values":[0.006424635,-0.014445293,0.004226414,-0.055166997,0.021697732,0.024184333,0.013057831,0.018346032,0.030591693,-0.0046903477,-0.01615887,0.0060890294,0.0037684536,-0.018477514,0.100860305,-0.006575002,-0.0006685915,-0.016859764,-0.013915601,-0.0011397424,0.02855716,-0.01803687
[EMBED DEBUG] dim=1536 text.length=21 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"puntos del artículo 2"}]},"outputDimensionality":1536}
[EMBED DEBUG] status=200 response={"embedding":{"values":[0.006424635,-0.014445293,0.004226414,-0.055166997,0.021697732,0.024184333,0.013057831,0.018346032,0.030591693,-0.0046903477,-0.01615887,0.0060890294,0.0037684536,-0.018477514,0.100860305,-0.006575002,-0.0006685915,-0.016859764,-0.013915601,-0.0011397424,0.02855716,-0.01803687
[EVALUATE DEBUG] LLM raw response: {
  "decision": "answer",
  "reason": "El contextoాన్నిA contiene el texto completo del ARTICULO 2° de la Ley 25.326, el cual define detalladamente los conceptos solicitados (Datos Sao personales, Datos Sao Sao hưởngibles, Archivo, Tratamiento, etc.).",
  "expand_requests": []
}
[CRAG] Decision: PARTIAL | El fragmento 1 contiene el inicio de las definiciones del artículo 2, pero el texto está truncado y no muestra todos los puntos o definiciones.
[CRAG] Re-searching with reformulated query: "definiciones completas del artículo 2 de la Ley 25.326 de protección de datos personales"
[EMBED DEBUG] dim=768 text.length=88 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"definiciones completas del artículo 2 de la Ley 25.326 de protección de datos personales"}]},"outputDimensionality":768}
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.02721342,0.016428255,0.036454443,-0.057225004,0.010515773,0.02591219,0.029674672,0.008569491,0.03738304,-0.013853547,-0.0129291145,0.011979316,-0.016183116,0.0011373428,0.11615782,-0.0046931063,-0.009405112,0.0065739057,0.012741943,-0.002994213,0.013206178,-0.02350494,-0.0
[EMBED DEBUG] dim=1536 text.length=88 body={"model":"models/gemini-embedding-001","content":{"parts":[{"text":"definiciones completas del artículo 2 de la Ley 25.326 de protección de datos personales"}]},"outputDimensionality":1536}
[EMBED DEBUG] status=200 response={"embedding":{"values":[-0.02721342,0.016428255,0.036454443,-0.057225004,0.010515773,0.02591219,0.029674672,0.008569491,0.03738304,-0.013853547,-0.0129291145,0.011979316,-0.016183116,0.0011373428,0.11615782,-0.0046931063,-0.009405112,0.0065739057,0.012741943,-0.002994213,0.013206178,-0.02350494,-0.0