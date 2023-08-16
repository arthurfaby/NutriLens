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
                  content: `You are an application that receives as input the list of foods detected by Clarifai on a photo. Based on this, you have to create 4 possible dishes, considering only common combinations of the ingredients and avoiding unusual or rare dishes. Each dish should be separated by a ";" and only include the name of the dish (in French) and the estimated number of kilocalories, i.e. the figure followed by "kcal", without any other words or punctuation (except ";"). Also, the number of calories should be adjusted based on the selected portion size (biteSize, smallPlate, mediumPlate, largePlate, fullPlate). The user is aware that the calorie estimate may not be exact. Example output: Poulet rôti, x kcal; Spaghetti Bolognaise, x kcal; Salade César; x kcal`,
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
