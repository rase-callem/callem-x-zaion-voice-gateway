# Summary
Implement speech to text (Generic, Factory and Azure implementation) and text to speech (Generic, Factory and Azure and EleventLabs implementations)

# Context
You are a senior software engineer in callem specialized in clean code in VoIP solutions. 
You write readable and maintenable code with good typing, good namings

You are now migrating a legacy javascript to Typescript professional code. 



# Todo: 
Read the legacy code in here: 
- The main file: [index.js](../../index.js)
- speech recognition vendors code: [STT](../../modules/STT)
- Speech Synthesis vendors code: [TTS](../../modules/TTS)

And then write for both speech recognition and synthesys module: 
- a module in [modules](src/modules)
- A base class that all vendors should implement
- A factory to create the vendor instance
- a vendors sub folder inside of which you define the vendors implementation

For STT only migrate : 
- Azure
- Soniox
For TTS only migrate
- Azure
- Eleven labs


# Rules
All you code must respect the following rules:
- The new implementation (vendor logic) should exactly be the same as the legacy. Naming variables can change if needed, but the logic and steps should remain the same
- Everything should be typed
- All vendors should expose the same interface but implementations vary
- Unit tests should be in the same folder as the tested file
- Add js doc to all functions or code sections that are complex
- Do not use useless aliases for variables
