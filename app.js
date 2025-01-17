require("dotenv").config();

const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { ClarifaiStub, grpc } = require("clarifai-nodejs-grpc");

// Création du serveur
const app = express();
const upload = multer({ dest: "uploads/" });

// Clés d'API
const clarifaiKey = process.env.CLARIFAI_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const key = process.env.KEY;

// Middleware pour créer un token
app.post("/login", express.json(), (req, res) => {
  const SECRET_STRING = process.env.KEY;
  if (req.body.password === SECRET_STRING) {
    const user = { id: 1, username: "admin" };
    const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "2h" });
    res.json({ token: token });
  } else {
    res.sendStatus(403); // Send forbidden status if password doesn't match
  }
});

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, "public")));

// Middleware pour vérifier le token de Clarifai
const stub = ClarifaiStub.grpc();
const metadata = new grpc.Metadata();
metadata.set("authorization", `Key ${clarifaiKey}`);

app.set('trust proxy', 1);

// Middleware pour vérifier le token de OpenAI
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limite chaque IP à 100 requêtes par fenêtre
});

// Vérification du délimiteur
app.use(limiter);

// Fonction pour vérifier le token
function verifyToken(req, res, next) {
  const bearerHeader = req.headers["authorization"];
  if (typeof bearerHeader !== "undefined") {
    const bearer = bearerHeader.split(" ");
    const bearerToken = bearer[1];
    req.token = bearerToken;
    next();
  } else {
    res.sendStatus(403);
  }
}

app.post("/upload", verifyToken, upload.single("image"), async (req, res) => {
  jwt.verify(req.token, process.env.JWT_SECRET, (err, authData) => {
    if (err) {
      res.sendStatus(403);
    } else {
      const portion = req.body.portionSize;
      const language = req.body.language;
      const imageFile = fs.readFileSync(req.file.path);
      const encodedImage = Buffer.from(imageFile).toString("base64"); // Use Buffer.from()

      // Envoi de l'image à Clarifai
      stub.PostModelOutputs(
        {
          model_id: "bd367be194cf45149e75f01d59f77ba7", // The 'food' model ID
          inputs: [
            {
              data: {
                image: {
                  base64: encodedImage,
                },
              },
            },
          ],
        },
        metadata,
        async (err, clarifaiResponse) => {
          if (err) {
            console.error(err);
            res.status(500).json({ error: "Failed to call Clarifai API" });
            return;
          }

          const foodItems = clarifaiResponse.outputs[0].data.concepts.map(
            (concept) => concept.name
          );

          console.log("foodItems", foodItems);

          // Envoi de la liste des aliments à OpenAI
          const openAIResponse = await axios({
            method: "post",
            url: "https://api.openai.com/v1/chat/completions",
            headers: {
              Authorization: `Bearer ${openaiKey}`,
              "Content-Type": "application/json",
            },
            data: {
              model: "gpt-4", // Add the model here
              messages: [
                {
                  role: "system",
                  content: `You are an app that receives an input of foods detected by AI in a photo. Your task is to filter out overlapping and redundant items from the list and, based on the list, create 4 dishes. Consider only common combinations of the ingredients and avoid unusual dishes. Each dish must be separated by a ";" and include the name of the dish (in ${language}, with appropriate special characters), the estimated number of kilocalories and the macronutrients (ONLY the value followed by g). The figure for kilocalories should be followed by "kcal", and the macronutrients by "g" (only the value and the "g", no "carbs", etc.). Use the following guidelines for portion sizes: - unitSize: depends on the product - smallPlate: 150-300 kcal - mediumPlate: 300-550 kcal - largePlate: 550-800 kcal - fullPlate: 800-1200 kcal. If you really cannot keep your estimates within the range, you can go over or under it without any problem. OUTPUTS ONLY LIKE THE EXAMPLE OUTPUT. Example output: Poulet rôti, x kcal, [carbs value] g, [proteins value] g, [fats value] g;...`,
                },
                {
                  role: "user",
                  content: `the portion size is ${portion} and the food items are ${foodItems.join(
                    ", "
                  )}`,
                },
              ],
            },
          });

          if (
            openAIResponse.data.choices &&
            openAIResponse.data.choices.length > 0 &&
            openAIResponse.data.choices[0].message
          ) {
            let dishAndCalories =
              openAIResponse.data.choices[0].message.content.trim();

            // Création d'une liste de plats en divisant la chaîne par ";"
            let dishList = dishAndCalories.split(";");

            // Nettoyage de chaque élément de la liste
            dishList = dishList.map((dish) => dish.trim().replace(/\.$/, ""));

            res.json({ dishAndCalories: dishList });
          } else {
            // Handle the error
            console.log("Error in OpenAI response:", openAIResponse.data);
            res
              .status(500)
              .json({ error: "An error occurred while processing the image" });
          }
        }
      );
    }
  });
});
app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
