# Interactieve Epidemiologie & Statistiek Leeromgeving

Een moderne webapplicatie voor Bachelorstudenten om epidemiologie en biostatistiek spelenderwijs te oefenen met AI-ondersteuning.

## Functies

### 1. Socratische Chatbot met RAG
- Intelligente chatbot die vragen stelt in plaats van direct antwoorden te geven
- Gebruikt Retrieval Augmented Generation (RAG) voor contextbewuste antwoorden
- Gebaseerd op door docenten geüploade cursusmateriaal

### 2. "Ik Leg Uit" Module
- 30 vooraf ingeladen begrippen (epidemiologie en biostatistiek)
- Studenten leggen begrippen uit in eigen woorden
- AI geeft gedetailleerde feedback op volledigheid en correctheid

### 3. Chat Systeem
- Meerdere conversaties beheren
- Real-time interactie met LLM
- Context uit documenten wordt automatisch opgehaald

### 4. Admin/Docent Dashboard
- Gebruikersbeheer (rollen wijzigen)
- Document upload voor RAG systeem
- Begrippen beheer
- Systeemconfiguratie

## Technologie Stack

- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** Tailwind CSS
- **Database:** Supabase (PostgreSQL + pgvector)
- **Authenticatie:** Supabase Auth
- **LLM:** Groq API (LLama 3.3 70B)
- **Embeddings:** OpenAI API (text-embedding-3-small)
- **Routing:** React Router v6

## Setup Instructies

### 1. API Keys Configureren

Open het `.env` bestand en voeg je API keys toe:

```env
VITE_GROQ_API_KEY=jouw_groq_api_key_hier
VITE_OPENAI_API_KEY=jouw_openai_api_key_hier
```

#### Groq API Key verkrijgen:
1. Ga naar [https://console.groq.com](https://console.groq.com)
2. Maak een account aan
3. Genereer een nieuwe API key
4. Kopieer en plak in `.env`

#### OpenAI API Key verkrijgen:
1. Ga naar [https://platform.openai.com](https://platform.openai.com)
2. Maak een account aan
3. Navigeer naar API Keys
4. Genereer een nieuwe API key
5. Kopieer en plak in `.env`

### 2. Applicatie Starten

```bash
npm install
npm run dev
```

De applicatie draait nu op `http://localhost:5173`

### 3. Eerste Admin Account Aanmaken

**BELANGRIJK:** Het email adres **l.d.j.kuijper@vu.nl** krijgt automatisch admin rechten bij registratie!

1. Ga naar de login pagina
2. Klik op "Nog geen account? Registreer nu"
3. Registreer met het email: **l.d.j.kuijper@vu.nl**
4. Vul je volledige naam en wachtwoord in
5. Je wordt automatisch als **Admin** aangemeld

Alle andere registraties krijgen standaard de rol "Student".

## Gebruikersrollen

### Student
- Toegang tot Chat, Ik Leg Uit, Quiz, Projecten, Samenwerken
- Kan begrippen uitleggen en feedback ontvangen
- Kan met AI chatbot communiceren

### Docent
- Alle student functionaliteit
- Kan documenten uploaden voor RAG systeem
- Kan begrippen toevoegen en beheren
- Kan datasets uploaden voor projecten

### Admin (l.d.j.kuijper@vu.nl)
- Alle docent functionaliteit
- Kan gebruikersrollen wijzigen (studenten promoveren tot docent)
- Volledige toegang tot alle beheersfuncties
- Kan audit logs bekijken

## Belangrijke Functies voor Admin

### Gebruikersrollen Wijzigen
1. Log in als admin
2. Ga naar "Beheer" in het menu
3. Selecteer het tabblad "Gebruikers"
4. Zoek de student die je wilt promoveren
5. Klik op "→ Docent" om de rol te wijzigen

**Let op:** Alleen de admin kan rollen wijzigen. Rolwijzigingen worden gelogd in de audit log.

### Documenten Uploaden voor RAG
1. Ga naar "Beheer" → "Documenten"
2. Klik op "Document Uploaden"
3. Upload PDF's, slides, of artikelen
4. Het systeem verwerkt documenten automatisch:
   - Tekst extractie
   - Chunking (500 tokens per chunk)
   - Embedding generatie met OpenAI
   - Opslag in Supabase vector database

Deze documenten worden gebruikt om contextuele antwoorden te geven in de chatbot.

### Begrippen Toevoegen
1. Ga naar "Beheer" → "Begrippen"
2. Klik op "Begrip Toevoegen"
3. Vul naam, categorie, en definitie in
4. Het begrip is nu beschikbaar in de "Ik Leg Uit" module

## Database Structuur

De applicatie gebruikt Supabase met de volgende hoofdtabellen:

- **profiles:** Gebruikersprofielen met rollen
- **documents & document_chunks:** RAG systeem met vector embeddings
- **conversations & messages:** Chat geschiedenis
- **concepts & student_explanations:** "Ik Leg Uit" module data
- **quiz_questions & quiz_sets:** Quiz systeem (in ontwikkeling)
- **projects & datasets:** Project module (in ontwikkeling)
- **collaboration_sessions:** Samenwerkingsfunctionaliteit (in ontwikkeling)

## Security Features

### Row Level Security (RLS)
Alle database tabellen hebben strikte RLS policies:
- Studenten kunnen alleen eigen data zien
- Docenten kunnen student data lezen maar niet wijzigen
- Admin heeft volledige toegang
- Document upload is beperkt tot docenten en admin

### Role-Based Access Control
- Frontend en backend verificatie van gebruikersrollen
- Audit logging voor kritieke acties (rolwijzigingen)
- API rate limiting per gebruiker

### Data Encryption
- Wachtwoorden worden gehashed door Supabase Auth
- API keys zijn alleen server-side beschikbaar
- Bestanden worden veilig opgeslagen in Supabase Storage

## Modules Status

### ✅ Volledig Geïmplementeerd
- Authenticatie systeem met rolbeheer
- Dashboard met statistieken
- Chat systeem met Groq LLM
- RAG systeem met OpenAI embeddings
- "Ik Leg Uit" module met AI feedback
- Admin dashboard met gebruikersbeheer

### 🚧 In Ontwikkeling
- Quiz module met ShareStats integratie
- Project module voor dataset analyse
- Samenwerkingsfunctionaliteit
- Document processing voor PDF's
- Real-time collaboration features

## Troubleshooting

### Chatbot geeft geen antwoorden
- Controleer of `VITE_GROQ_API_KEY` correct is ingesteld in `.env`
- Herstart de development server na het wijzigen van `.env`
- Check de browser console voor error berichten

### RAG context wordt niet opgehaald
- Controleer of `VITE_OPENAI_API_KEY` correct is ingesteld
- Zorg dat er documenten zijn geüpload door docent/admin
- Documenten moeten status "completed" hebben in de admin panel

### Kan geen documenten uploaden
- Alleen docenten en admin kunnen documenten uploaden
- Check je rol in het profiel menu (rechtsboven)
- Vraag admin om je rol te wijzigen indien nodig

### Admin kan rollen niet wijzigen
- Alleen het email **l.d.j.kuijper@vu.nl** heeft admin rechten
- Log opnieuw in als de rol recent is gewijzigd
- Check de browser console voor permission errors

## Contact & Support

Voor vragen of problemen, neem contact op met de administrator via l.d.j.kuijper@vu.nl

## Toekomstige Ontwikkeling

Geplande features:
- ShareStats GitHub integratie voor quiz vragen
- Automatische quiz validatie via RAG
- Dataset upload en analyse tools
- Real-time samenwerkingsfunctionaliteit met groepschat
- Voortgang tracking en analytics voor docenten
- Export functionaliteit voor student data
- Mobile-responsive design optimalisatie

## Licentie

Dit project is ontwikkeld voor educatief gebruik aan de VU Amsterdam.
