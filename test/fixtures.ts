// Transcripts T01 / T03 / T10 from the Sept 2026 seed data (anonymised), lightly condensed.
export const FIXTURES: Record<string, string> = {
  t01: `Front Desk: Good morning, Aangan Studio.
Caller: Hi, I'm Priya. I got your number from a friend -- Shruti Joshi. She had her flat done by you in Aundh.
Caller: We have a 3BHK in Kothrud -- Dahanukar Colony. We want to redo the whole thing -- kitchen, living room, both bedrooms.
Caller: About 1,400 sq ft carpet.
Caller: We'd like to be done by March. We're in no rush.
Front Desk: Are you the owner?
Caller: Yes -- myself and my husband. He knows we're calling and is happy to go ahead.
Caller: My email is priya@example.com.`,
  t03: `Front Desk: Good afternoon, Aangan Studio.
Caller: Hello, my name is Suresh Patil. I'm in Nashik -- would you be able to take on a project here? I want to redo my home office and study.
Front Desk: We only work in Pune and PCMC at the moment.
Caller: Alright, understood. Thanks.`,
  t10: `Front Desk: Good afternoon, Aangan Studio.
Caller: Hi. I have a 1BHK in Kharadi -- about 550 sq ft. I want to do the kitchen and one bedroom. My budget is 1 to 1.5 lakh maximum for everything. Is that possible with you?
Front Desk: Thank you for sharing that.
Caller: Okay, thank you for being straight.`,
};

// New dummy transcripts for the live end-to-end test (not from the seed PDF).
FIXTURES.clinic = `Front Desk: Thank you for calling Aangan Studio. How can I help you today?
Caller: Hi, this is Dr. Meera Kulkarni. I'm opening a dental clinic in Baner and I found you on Instagram.
Front Desk: Congratulations. How big is the space?
Caller: About 1,200 square feet. It's a bare shell right now. I need a reception, three treatment rooms and a small waiting lounge.
Front Desk: And when do you need it ready?
Caller: I'd like to open by early January. So about three months from now.
Front Desk: Are you the one deciding on this?
Caller: Yes, it's my clinic, I'm the owner. My email is meera.kulkarni.demo@example.com.
Front Desk: Perfect, your designer will confirm the consultation by email.`;
FIXTURES.gym = `Front Desk: Thank you for calling Aangan Studio. How can I help you today?
Caller: Hello, I'm Rohit. I'm setting up a gym in Viman Nagar, about 2,500 square feet. I saw your office projects on LinkedIn and wanted the interiors done.
Front Desk: Thank you for thinking of us. Gyms are outside what we take on at the moment.
Caller: Oh, okay. Even for the reception area only?
Front Desk: I'm sorry, we don't take gym projects. You could look for a studio that specialises in fitness spaces.
Caller: Alright, thanks.`;
FIXTURES.lowbudget = `Front Desk: Thank you for calling Aangan Studio. How can I help you today?
Caller: Hi, I'm Sneha. I have a 2BHK in Hinjewadi, around 1,000 square feet. I want the whole flat redone, kitchen, wardrobes, both bedrooms and the living room, done by March.
Front Desk: That's a full redesign. Are you the owner?
Caller: Yes, my husband and I own it. Just so you know, my total budget is 2 lakh for everything.
Front Desk: Thank you for sharing that.
Caller: So can you do it?`;
FIXTURES.complaint = `Front Desk: Thank you for calling Aangan Studio. How can I help you today?
Caller: Hi, I'm Vikas Rane. My designer on the Baner flat project hasn't replied to my messages for four days and the tile work looks wrong. I want to talk to someone senior.
Front Desk: I'm sorry to hear that. Can I take your number?
Caller: Sure, it's 98765 12345. Please have someone call me back today.`;
