UPDATE public.bot_settings
SET value = jsonb_set(value::jsonb, '{message}', to_jsonb($msg$ආයුබෝවන් 🙏

ඔයාගේ භාණ්ඩේ තාම විකිණිලා නැද්ද? 🙂 අපි ඇත්තටම කැමතියි ඒක හැකි ඉක්මනින් විකුණාගන්න ඔයාට උදව් කරන්න.

ඔයාගේ ad එක live වුණාම, හරියටම ඒ භාණ්ඩය හොයන ගැනුම්කරුවන්ට අපි කෙලින්ම *WhatsApp message* එකක් යවනවා. ඒකයි TakTak ශ්‍රී ලංකාවේ වේගවත්ම විකුණුම් තැන 💚

මේ photo එකේ ඉන්නේ අපෙන් ඉක්මනින් විකුණාගත්ත sellers ලා එවපු messages 👆

💳 Commercial Bank — BuildStart (Pvt) Ltd — *1001075073*
slip එකේ photo එකක් මෙතනට එවන්න, විනාඩි කිහිපයකින් ඔයාගේ ad එක live! ⚡$msg$::text)),
    updated_at = now()
WHERE key = 'payment_followup';