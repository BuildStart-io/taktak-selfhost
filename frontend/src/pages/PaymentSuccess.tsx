import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, MessageCircle } from "lucide-react";
import taktakLogo from "@/assets/taktak-logo.png";

const PaymentSuccess = () => {
  const whatsappUrl = "https://wa.me/94770000000"; // TODO: replace with the bot's WhatsApp number

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-md shadow-card">
        <CardContent className="flex flex-col items-center py-10 px-6 text-center space-y-5">
          <img src={taktakLogo} alt="TakTak" className="h-12 w-auto" />
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
            <CheckCircle2 className="h-9 w-9 text-success" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Payment Received</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Your listing is being published on TakTak right now. You'll get a
              WhatsApp confirmation from our bot in a few seconds.
            </p>
          </div>
          <Button asChild size="lg" className="w-full">
            <a href={whatsappUrl}>
              <MessageCircle className="mr-2 h-4 w-4" />
              Return to WhatsApp
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">
            You can safely close this window.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default PaymentSuccess;
